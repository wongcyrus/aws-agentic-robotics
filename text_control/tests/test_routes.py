import asyncio
import base64
import json
from types import SimpleNamespace

import pytest
import boto3
from botocore.exceptions import ClientError
from flask import Flask, jsonify

from routes import api as api_routes
from routes import auth as auth_routes
from routes import ui as ui_routes


@pytest.fixture
def app():
    flask_app = Flask(__name__, template_folder="../templates", static_folder="../static")
    flask_app.secret_key = "test-secret"
    flask_app.register_blueprint(api_routes.api_bp)
    flask_app.register_blueprint(auth_routes.auth_bp)
    flask_app.register_blueprint(ui_routes.ui_bp)
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def internal_headers():
    return {"X-Internal-Secret": "test-internal-secret"}


def test_robot_crud_routes(client, internal_headers, monkeypatch):
    monkeypatch.setattr(api_routes, "list_robots", lambda: [{"id": "r1"}])
    monkeypatch.setattr(api_routes, "get_robot", lambda robot_id: {"id": robot_id} if robot_id == "r1" else None)
    monkeypatch.setattr(api_routes, "upsert_robot", lambda robot_id, data: {"id": robot_id, **data})
    deleted = []
    monkeypatch.setattr(api_routes, "delete_robot", lambda robot_id: deleted.append(robot_id))

    assert client.get("/api/robots", headers=internal_headers).get_json() == [{"id": "r1"}]
    assert client.get("/api/robots/r1", headers=internal_headers).status_code == 200
    assert client.get("/api/robots/missing", headers=internal_headers).status_code == 404
    assert client.post("/api/robots", json={}, headers=internal_headers).status_code == 400
    created = client.post("/api/robots", json={"id": "r2", "robot_name": "Two"}, headers=internal_headers)
    assert created.status_code == 201
    assert client.put("/api/robots/r2", json={"robot_name": "Updated"}, headers=internal_headers).get_json()["robot_name"] == "Updated"
    assert client.delete("/api/robots/r2", headers=internal_headers).get_json() == {"deleted": True}
    assert deleted == ["r2"]


def test_run_action_routes_methods(client, internal_headers, monkeypatch):
    calls = []

    async def process(actions, robot):
        calls.append((actions, robot))
        return [{"success": True}]

    monkeypatch.setattr(api_routes.robot_service, "process_actions", process)
    assert client.post("/api/run_action/robot_1", json={}, headers=internal_headers).status_code == 400
    assert client.post(
        "/api/run_action/robot_1",
        json={"method": "Bad", "action": "move"},
        headers=internal_headers,
    ).status_code == 400
    assert client.post(
        "/api/run_action/robot_1",
        json={"method": "RunAction", "action": "move"},
        headers=internal_headers,
    ).get_json()["results"][0]["success"] is True
    client.post(
        "/api/run_action/robot_1",
        json={"method": "StopAction", "action": "ignored"},
        headers=internal_headers,
    )
    assert calls == [(["move"], "robot_1"), (["stop"], "robot_1")]


def test_capture_and_image_routes(client, internal_headers, monkeypatch):
    monkeypatch.setattr(
        api_routes.robot_service,
        "capture_image",
        lambda robot_id: {"success": robot_id == "robot_1"},
    )
    assert client.post("/api/capture_image/robot_1", headers=internal_headers).status_code == 200
    assert client.post("/api/capture_image/robot_2", headers=internal_headers).status_code == 504

    monkeypatch.delenv("MEDIA_BUCKET_NAME", raising=False)
    assert client.get("/api/image/key.jpg", headers=internal_headers).status_code == 500
    monkeypatch.setenv("MEDIA_BUCKET_NAME", "bucket")
    monkeypatch.setattr(
        boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            generate_presigned_url=lambda *args, **kwargs: "https://signed"
        ),
        raising=False,
    )
    assert client.get("/api/image/key.jpg", headers=internal_headers).get_json()["image_url"] == "https://signed"


def test_chat_helper_success_validation_and_error(app, monkeypatch):
    class Agent:
        async def invoke_async(self, message):
            if message == "fail":
                raise RuntimeError("model down")
            return "answer"

    async def create_agent(*args, **kwargs):
        return Agent()

    monkeypatch.setattr(api_routes, "create_robot_agent_mcp", create_agent)
    monkeypatch.setattr(api_routes, "get_robot", lambda _robot: {"robot_name": "R", "context": "C"})
    with app.app_context():
        empty, status = asyncio.run(api_routes._chat({"message": " "}))
        success = asyncio.run(api_routes._chat({"message": "hello", "session_id": 7, "robots": ["r1"]}))
        failure, failure_status = asyncio.run(api_routes._chat({"message": "fail", "session_id": "s"}))
    assert status == 400
    assert success.get_json() == {"response": "answer", "session_id": "7"}
    assert failure_status == 500
    assert failure.get_json()["error"] == "model down"


def test_welcome_pending_goodbye_and_questions(client, monkeypatch):
    monkeypatch.setattr(api_routes, "validate_authentication", lambda **kwargs: ("project", None))
    monkeypatch.setattr(
        api_routes,
        "get_pending_speech_message",
        lambda _presenter: {"id": "msg", "message": "Queued greeting"},
    )
    deleted = []
    monkeypatch.setattr(api_routes, "delete_speech_message", lambda message_id: deleted.append(message_id))
    payload = {"sessionId": "s", "traceId": "t", "languageCode": "en"}
    assert client.post("/api/welcome", json=payload).get_json()["replyText"] == "Queued greeting"
    assert deleted == ["msg"]
    assert client.post("/api/goodbye", json=payload).get_json()["replyText"].startswith("Goodbye")
    questions = client.post("/api/recquestions", json=payload).get_json()
    assert questions["traceId"] == "t"
    assert "What can you do?" in questions["data"]


def test_speech_route_success_and_error(client, internal_headers, monkeypatch):
    class MCP:
        async def call_tool(self, name, arguments):
            return {"content": [{"type": "text", "text": "Spoken successfully"}]}

    import mcp_client

    monkeypatch.setattr(mcp_client, "get_mcp_client", lambda: MCP())
    assert client.post("/api/speech/robot_1", json={}, headers=internal_headers).status_code == 400
    response = client.post(
        "/api/speech/robot_1",
        json={"text": "hello", "language": "en"},
        headers=internal_headers,
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is True


def _token(username="user"):
    payload = base64.b64encode(json.dumps({"cognito:username": username}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def test_auth_routes(client, monkeypatch):
    monkeypatch.setattr(
        auth_routes,
        "cognito_client",
        SimpleNamespace(
            admin_initiate_auth=lambda **kwargs: {
                "AuthenticationResult": {
                    "IdToken": _token(),
                    "AccessToken": "access",
                    "RefreshToken": "refresh",
                }
            }
        ),
    )
    assert client.post("/auth/login", json={}).status_code == 400
    login = client.post("/auth/login", json={"username": "user", "password": "pass"})
    assert login.status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": "refresh"}).status_code == 200
    assert client.post("/auth/verify", json={}).status_code == 400
    assert client.post("/auth/verify", json={"token": "token"}).get_json()["valid"] is True
    assert client.get("/auth/config").status_code == 200
    assert client.post("/auth/logout").get_json()["success"] is True


def test_login_maps_cognito_authorization_error(client, monkeypatch):
    error = ClientError(
        {"Error": {"Code": "NotAuthorizedException", "Message": "bad"}},
        "AdminInitiateAuth",
    )
    monkeypatch.setattr(
        auth_routes,
        "cognito_client",
        SimpleNamespace(
            admin_initiate_auth=lambda **kwargs: (_ for _ in ()).throw(error)
        ),
    )
    assert client.post("/auth/login", json={"username": "u", "password": "p"}).status_code == 401


def test_ui_cleanup_routes_with_session(client, monkeypatch):
    monkeypatch.setattr(ui_routes, "get_all_speech_messages", lambda: [{"id": "one"}])
    monkeypatch.setattr(ui_routes, "delete_all_speech_messages", lambda: 3)
    deleted = []
    monkeypatch.setattr(ui_routes, "delete_speech_message", lambda item: deleted.append(item))
    with client.session_transaction() as flask_session:
        flask_session["authenticated"] = True
        flask_session["user"] = {"username": "user"}
    assert client.get("/").status_code == 302
    assert client.get("/cleanup/api/list").get_json()["messages"] == [{"id": "one"}]
    assert client.post("/cleanup/api/delete-all").get_json()["deleted_count"] == 3
    assert client.post("/cleanup/api/delete/one").get_json()["message_id"] == "one"
    assert deleted == ["one"]


class StreamingAgent:
    async def invoke_async(self, message):
        return f"answer:{message}"


async def _create_streaming_agent(*args, **kwargs):
    return StreamingAgent()


async def _fake_stream(_agent, ask_text, session_id, trace_id, extra):
    yield f"data: {json.dumps({'replyText': ask_text, 'isFinal': False})}\n\n"
    yield f"data: {json.dumps({'replyText': '', 'isFinal': True})}\n\n"


def test_talk_stream_success_and_auth_failure(client, monkeypatch):
    monkeypatch.setattr(api_routes, "validate_authentication", lambda **kwargs: ("project", None))
    monkeypatch.setattr(api_routes, "get_robot", lambda _project: {"robot_name": "R", "context": "Lab"})
    monkeypatch.setattr(api_routes, "create_robot_agent_mcp", _create_streaming_agent)
    monkeypatch.setattr(api_routes, "stream_agent_response", _fake_stream)
    payload = {
        "askText": "move",
        "sessionId": "s",
        "traceId": "t",
        "userParams": "robot_1",
    }
    response = client.post("/api/talk", json=payload)
    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"
    assert '"replyText": "move"' in response.get_data(as_text=True)

    app_error = Flask(__name__)
    app_error.register_blueprint(api_routes.api_bp)
    monkeypatch.setattr(
        api_routes,
        "validate_authentication",
        lambda **kwargs: (None, (jsonify({"error": "denied"}), 401)),
    )
    assert app_error.test_client().post("/api/talk", json=payload).status_code == 401


def test_welcome_llm_and_static_fallback(client, monkeypatch):
    import strands
    import strands.models

    monkeypatch.setattr(api_routes, "validate_authentication", lambda **kwargs: ("project", None))
    monkeypatch.setattr(api_routes, "get_pending_speech_message", lambda _presenter: None)
    monkeypatch.setattr(api_routes, "get_robot", lambda _project: {"robot_name": "R", "context": "Lab"})

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def invoke_async(self, _message):
            return "Generated greeting"

    monkeypatch.setattr(strands, "Agent", Agent)
    monkeypatch.setattr(strands.models, "BedrockModel", lambda **kwargs: object())
    payload = {"sessionId": "s", "traceId": "t", "languageCode": "en"}
    assert client.post("/api/welcome", json=payload).get_json()["replyText"] == "Generated greeting"

    Agent.invoke_async = lambda self, message: (_ for _ in ()).throw(RuntimeError("down"))
    fallback = client.post("/api/welcome", json=payload)
    assert fallback.get_json()["replyText"].startswith("Hello")


def test_nonstreaming_and_streaming_strands_endpoints(client, monkeypatch):
    monkeypatch.setattr(api_routes, "validate_authentication", lambda **kwargs: ("project", None))
    monkeypatch.setattr(api_routes, "get_robot", lambda _project: None)
    monkeypatch.setattr(api_routes, "create_robot_agent_mcp", _create_streaming_agent)
    monkeypatch.setattr(api_routes, "stream_agent_response", _fake_stream)
    payload = {"askText": "hello", "sessionId": "s", "traceId": "t"}

    response = client.post("/api/xiaoice-chat-api-strands", json=payload)
    assert response.status_code == 200
    assert response.get_json()["replyText"] == "answer:hello"

    for path in [
        "/api/xiaoice-chat-api-strands-stream",
        "/api/xiaoice-stream-machine/api/talk",
    ]:
        streamed = client.post(path, json=payload)
        assert streamed.status_code == 200
        assert '"isFinal": true' in streamed.get_data(as_text=True)


def test_ui_pages_render_for_authenticated_session(client):
    with client.session_transaction() as flask_session:
        flask_session["authenticated"] = True
        flask_session["user"] = {"username": "user"}
    assert client.get("/index").status_code == 200
    assert client.get("/robot").status_code == 200
    assert client.get("/cleanup").status_code == 200
    assert client.get("/login").status_code == 200
    assert client.get("/favicon.ico").status_code == 404
