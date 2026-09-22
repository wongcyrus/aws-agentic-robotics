from types import SimpleNamespace

import pytest
from flask import Flask, g, jsonify

import cache_utils
import middleware
from services import chat_service


class FakeCache:
    def __init__(self):
        self.values = {}
        self.set_calls = []

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value, timeout):
        self.values[key] = value
        self.set_calls.append((key, value, timeout))


def test_get_cache_requires_application_context():
    assert cache_utils.get_cache() is None
    app = Flask(__name__)
    app.cache = FakeCache()
    with app.app_context():
        assert cache_utils.get_cache() is app.cache


def test_cache_result_caches_sync_and_async_results():
    app = Flask(__name__)
    app.cache = FakeCache()
    sync_calls, async_calls = [], []

    @cache_utils.cache_result(timeout=10, key_prefix="sync")
    def sync_value():
        sync_calls.append(1)
        return "sync-result"

    @cache_utils.cache_result(timeout=20, key_prefix="async")
    async def async_value():
        async_calls.append(1)
        return "async-result"

    with app.app_context():
        assert sync_value() == sync_value() == "sync-result"
        import asyncio

        assert asyncio.run(async_value()) == "async-result"
        assert asyncio.run(async_value()) == "async-result"
    assert len(sync_calls) == len(async_calls) == 1


def test_validate_jwt_token_success_missing_key_and_error(monkeypatch):
    monkeypatch.setattr(middleware, "get_jwks", lambda: {"keys": [{"kid": "one"}]})
    monkeypatch.setattr(middleware.jwt, "get_unverified_header", lambda _token: {"kid": "one"})
    monkeypatch.setattr(
        middleware.jwt.algorithms.RSAAlgorithm, "from_jwk", lambda _jwk: "key"
    )
    monkeypatch.setattr(middleware.jwt, "decode", lambda *args, **kwargs: {"sub": "user"})
    assert middleware.validate_jwt_token("token") == {"sub": "user"}
    monkeypatch.setattr(middleware.jwt, "get_unverified_header", lambda _token: {"kid": "other"})
    assert middleware.validate_jwt_token("token") is None


def test_internal_secret_requires_explicit_configuration(monkeypatch):
    monkeypatch.delenv("INTERNAL_ROBOT_SECRET", raising=False)
    assert middleware.has_valid_internal_secret("test-internal-secret") is False
    monkeypatch.setenv("INTERNAL_ROBOT_SECRET", "configured")
    assert middleware.has_valid_internal_secret("configured") is True
    assert middleware.has_valid_internal_secret("wrong") is False
    monkeypatch.setattr(
        middleware, "get_jwks", lambda: (_ for _ in ()).throw(RuntimeError("down"))
    )
    assert middleware.validate_jwt_token("token") is None


def test_jwks_cache_fetches_only_once(monkeypatch):
    calls = []
    middleware._jwks_cache = None
    monkeypatch.setattr(
        middleware.requests,
        "get",
        lambda *args, **kwargs: SimpleNamespace(
            raise_for_status=lambda: calls.append("raised"),
            json=lambda: {"keys": []},
        ),
    )
    assert middleware.get_jwks() == {"keys": []}
    assert middleware.get_jwks() == {"keys": []}
    assert calls == ["raised"]


def test_hybrid_auth_internal_session_gateway_jwt_and_rejection(monkeypatch):
    app = Flask(__name__)
    app.secret_key = "secret"

    @app.get("/protected")
    @middleware.require_hybrid_auth
    def protected():
        return jsonify(g.current_user)

    client = app.test_client()
    assert client.get("/protected").status_code == 401
    internal = client.get(
        "/protected", headers={"X-Internal-Secret": "test-internal-secret"}
    )
    assert internal.get_json()["username"] == "internal_system"
    with client.session_transaction() as flask_session:
        flask_session["authenticated"] = True
        flask_session["user"] = {"username": "session-user"}
    assert client.get("/protected").get_json()["username"] == "session-user"
    with client.session_transaction() as flask_session:
        flask_session.clear()
    monkeypatch.setattr(middleware, "extract_api_gateway_auth_context", lambda: {"sub": "gateway"})
    assert client.get("/protected").get_json()["sub"] == "gateway"
    monkeypatch.setattr(middleware, "extract_api_gateway_auth_context", lambda: None)
    monkeypatch.setattr(middleware, "validate_jwt_token", lambda _token: {"sub": "jwt"})
    assert client.get("/protected", headers={"Authorization": "Bearer token"}).get_json()["sub"] == "jwt"


def test_extract_api_gateway_auth_context():
    app = Flask(__name__)
    event = {"requestContext": {"authorizer": {"claims": {"sub": "user"}}}}
    with app.test_request_context("/", environ_overrides={"lambda.event": event}):
        assert middleware.extract_api_gateway_auth_context() == {"sub": "user"}
    with app.test_request_context("/"):
        assert middleware.extract_api_gateway_auth_context() is None


def test_require_auth_and_web_auth_paths(monkeypatch):
    app = Flask(__name__)
    app.secret_key = "secret"

    @app.get("/api-only")
    @middleware.require_auth
    def api_only():
        return jsonify(g.current_user)

    @app.get("/login", endpoint="ui.login_page")
    def login():
        return "login"

    @app.get("/web")
    @middleware.require_web_auth
    def web():
        return jsonify(g.current_user)

    client = app.test_client()
    assert client.get("/api-only").status_code == 401
    monkeypatch.setattr(middleware, "validate_jwt_token", lambda _token: None)
    assert client.get("/api-only", headers={"Authorization": "Bearer bad"}).status_code == 401
    monkeypatch.setattr(middleware, "validate_jwt_token", lambda _token: {"sub": "user"})
    assert client.get("/api-only", headers={"Authorization": "Bearer good"}).get_json()["sub"] == "user"
    assert client.get("/web").status_code == 302
    with client.session_transaction() as flask_session:
        flask_session["authenticated"] = True
        flask_session["user"] = {"username": "web-user"}
    assert client.get("/web").get_json()["username"] == "web-user"


@pytest.mark.asyncio
async def test_chat_service_success_classification_and_extraction(monkeypatch):
    class Agent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def invoke_async(self, prompt):
            if "classify" in self.kwargs.get("system_prompt", ""):
                return {"response_type": "commands", "commands": ["move"], "confidence": 1}
            return "assistant response"

    async def action_descriptions():
        return ["move - Move forward"]

    async def actions():
        return {"move"}

    monkeypatch.setattr(chat_service, "Agent", Agent)
    monkeypatch.setattr(chat_service, "FileSessionManager", lambda **kwargs: "session-manager")
    monkeypatch.setattr(chat_service, "get_available_action_and_description", action_descriptions)
    monkeypatch.setattr(chat_service, "get_available_actions", actions)
    monkeypatch.setattr(
        chat_service,
        "get_robot",
        lambda _robot: {"robot_name": "Robot", "context": "Lab"},
    )
    response = await chat_service.get_chat_response("hello", "robot_1", "session")
    classification = await chat_service.classify_response_type("move", "move")
    extracted = await chat_service.extract_actions_from_response("move", "move")
    assert response["response"] == "assistant response"
    assert classification["commands"] == ["move"]
    assert extracted == ["move"]


@pytest.mark.asyncio
async def test_chat_service_error_and_classification_fallback(monkeypatch):
    class Agent:
        def __init__(self, **kwargs):
            pass

        async def invoke_async(self, prompt):
            raise RuntimeError("model down")

    async def action_descriptions():
        return []

    async def actions():
        return set()

    monkeypatch.setattr(chat_service, "Agent", Agent)
    monkeypatch.setattr(chat_service, "FileSessionManager", lambda **kwargs: object())
    monkeypatch.setattr(chat_service, "get_available_action_and_description", action_descriptions)
    monkeypatch.setattr(chat_service, "get_available_actions", actions)
    monkeypatch.setattr(chat_service, "get_robot", lambda _robot: None)
    assert (await chat_service.get_chat_response("hello", "robot_1", "session"))["error"] == "model down"
    fallback = await chat_service.classify_response_type("hello", "hello")
    assert fallback == {"type": "rephrase", "commands": [], "confidence": 0.5}
