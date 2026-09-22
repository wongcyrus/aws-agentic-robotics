import json
import time
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError
from flask import Flask

from models import actions
from utils import auth
from utils import lambda_logger


@pytest.fixture
def app():
    return Flask(__name__)


def test_get_secret_success_invalid_json_and_client_error(monkeypatch):
    responses = [
        {"SecretString": '{"key": "value"}'},
        {"SecretString": "not-json"},
        {},
        ClientError({"Error": {"Code": "Denied", "Message": "no"}}, "GetSecretValue"),
    ]

    class Client:
        def get_secret_value(self, **_kwargs):
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response

    monkeypatch.setattr(
        auth.boto3.session,
        "Session",
        lambda: SimpleNamespace(client=lambda **kwargs: Client()),
    )
    assert auth.get_secret("name") == {"key": "value"}
    assert auth.get_secret("name") is None
    assert auth.get_secret("name") is None
    assert auth.get_secret("name") is None


@pytest.mark.parametrize(
    ("headers", "path", "message"),
    [
        ({}, "/api/talk", "Missing authentication headers"),
        (
            {"X-Timestamp": "bad", "X-Sign": "x", "X-Key": "key"},
            "/api/xiaoice-stream-machine",
            "Invalid timestamp format",
        ),
    ],
)
def test_authentication_rejects_header_and_timestamp_errors(
    app, monkeypatch, headers, path, message
):
    monkeypatch.setattr(auth, "get_secret", lambda _name: None)
    with app.test_request_context(path, data="{}", headers=headers):
        project_id, error = auth.validate_authentication()
    assert project_id is None
    assert message in error.get_json()["error"]["message"]


def test_authentication_rejects_expired_and_unknown_access_keys(app, monkeypatch):
    monkeypatch.setattr(auth, "get_secret", lambda _name: None)
    expired = str(int((time.time() - 301) * 1000))
    with app.test_request_context(
        "/api/talk",
        data="{}",
        headers={"X-Timestamp": expired, "X-Sign": "x", "X-Key": "key"},
    ):
        _, expired_error = auth.validate_authentication(enforce_expiry=True)
    assert expired_error.get_json()["error"]["message"] == "Request timestamp expired"

    with app.test_request_context(
        "/api/talk",
        data="{}",
        headers={"X-Timestamp": "1", "X-Sign": "x", "X-Key": "unknown"},
    ):
        _, access_error = auth.validate_authentication()
    assert access_error.get_json()["error"]["message"] == (
        "Invalid access key or missing configuration"
    )


def test_authentication_accepts_secret_map_and_legacy_global_keys(app, monkeypatch):
    body = "{}"
    timestamp = str(int(time.time() * 1000))
    monkeypatch.setattr(
        auth,
        "get_secret",
        lambda _name: {
            "mapped": {"secret_key": "secret", "project_id": "mapped-project"}
        },
    )
    signature = auth.calculate_signature("secret", timestamp, body)
    with app.test_request_context(
        "/api/talk",
        data=body,
        headers={"X-Timestamp": timestamp, "X-Sign": signature, "X-Key": "mapped"},
    ):
        project_id, error = auth.validate_authentication(use_v2=False)
    assert (project_id, error) == ("mapped-project", None)

    monkeypatch.setattr(auth, "get_secret", lambda _name: None)
    monkeypatch.setenv("XiaoiceChatSecretKey", "global-secret")
    monkeypatch.setenv("XiaoiceChatAccessKey", "global-key")
    signature = auth.calculate_signature_v2("global-secret", timestamp, body)
    with app.test_request_context(
        "/api/talk",
        data=body,
        headers={
            "X-Timestamp": timestamp,
            "X-Sign": signature,
            "X-Key": "global-key",
        },
    ):
        project_id, error = auth.validate_authentication()
    assert (project_id, error) == ("Summer", None)


def test_action_models_list_mcp_tools(monkeypatch):
    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def list_tools(self):
            return [
                SimpleNamespace(tool_name="wave", description="Wave"),
                SimpleNamespace(name="stop", _tool_spec={"description": "Stop"}),
            ]

    monkeypatch.setattr(actions, "get_mcp_client", lambda: Client())
    assert __import__("asyncio").run(actions.get_available_actions()) == {"wave", "stop"}
    assert __import__("asyncio").run(
        actions.get_available_action_and_description()
    ) == ["wave - Wave", "stop - Stop"]


def test_lambda_logger_configuration(monkeypatch):
    logger = lambda_logger.logging.getLogger("coverage-test")
    logger.handlers.clear()
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "function")
    configured = lambda_logger.get_lambda_logger("coverage-test")
    assert configured.level == lambda_logger.logging.WARNING
    assert configured.propagate is False
    assert len(configured.handlers) == 1

    root = lambda_logger.logging.getLogger()
    root.handlers[:] = [lambda_logger.logging.NullHandler()]
    lambda_logger.configure_root_logger()
    assert len(root.handlers) == 1
