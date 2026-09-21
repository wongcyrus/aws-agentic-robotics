import importlib
import sys
from types import SimpleNamespace

import mcp_client


def _load_app(monkeypatch):
    monkeypatch.setattr(mcp_client, "get_mcp_client", lambda: SimpleNamespace())
    monkeypatch.setattr(mcp_client, "cleanup_mcp_client", lambda: None)
    sys.modules.pop("app", None)
    return importlib.import_module("app")


def test_application_hooks_add_cors_and_log_safely(monkeypatch, capsys):
    app_module = _load_app(monkeypatch)
    client = app_module.app.test_client()
    response = client.get("/", headers={"Authorization": "Bearer very-long-secret-token"})
    output = capsys.readouterr().out

    assert response.status_code == 302
    assert response.headers["Access-Control-Allow-Origin"] == "*"
    assert "Bearer ver...token" in output


def test_lambda_handler_notifies_and_delegates(monkeypatch):
    app_module = _load_app(monkeypatch)
    notified = []
    monkeypatch.setattr(
        mcp_client, "notify_new_invocation", lambda request_id: notified.append(request_id)
    )
    monkeypatch.setattr(
        app_module.awsgi2,
        "response",
        lambda flask_app, event, context: {"statusCode": 204, "event": event},
    )
    event = {
        "requestContext": {"http": {"method": "GET", "path": "/index"}},
    }
    result = app_module.handler(event, SimpleNamespace(aws_request_id="request-1"))
    assert result["statusCode"] == 204
    assert notified == ["request-1"]


def test_lambda_handler_tolerates_nonserializable_event_and_missing_request_id(
    monkeypatch,
):
    app_module = _load_app(monkeypatch)
    monkeypatch.setattr(
        app_module.awsgi2,
        "response",
        lambda flask_app, event, context: {"statusCode": 200},
    )
    result = app_module.handler({"value": object()}, SimpleNamespace())
    assert result == {"statusCode": 200}
