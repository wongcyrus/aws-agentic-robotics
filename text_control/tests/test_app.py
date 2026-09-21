import importlib
import inspect
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


def test_application_factory_can_skip_external_startup(monkeypatch):
    app_module = _load_app(monkeypatch)
    calls = []
    monkeypatch.setattr(app_module, "get_mcp_client", lambda: calls.append("initialized"))

    isolated_app = app_module.create_app(
        {"TESTING": True, "SECRET_KEY": "test-secret"},
        initialize_mcp=False,
    )

    assert isolated_app.config["TESTING"] is True
    assert isolated_app.config["SECRET_KEY"] == "test-secret"
    assert isolated_app.cache is not None
    assert calls == []


def test_lambda_entry_point_keeps_aws_signature(monkeypatch):
    app_module = _load_app(monkeypatch)
    assert list(inspect.signature(app_module.handler).parameters) == ["event", "context"]


def test_lambda_handler_notifies_and_delegates(monkeypatch):
    app_module = _load_app(monkeypatch)
    notified = []
    test_app = app_module.create_app({"TESTING": True}, initialize_mcp=False)
    event = {
        "requestContext": {"http": {"method": "GET", "path": "/index"}},
    }
    result = app_module.handle_lambda_request(
        event,
        SimpleNamespace(aws_request_id="request-1"),
        application=test_app,
        response_adapter=lambda flask_app, event, context: {
            "statusCode": 204,
            "event": event,
            "application": flask_app,
        },
        invocation_notifier=notified.append,
    )
    assert result["statusCode"] == 204
    assert result["application"] is test_app
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
