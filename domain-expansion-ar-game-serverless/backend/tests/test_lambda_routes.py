import base64
import inspect
import json
from types import SimpleNamespace

import pytest

import commentary
import commentary_tts
import lambda_function


def _body(response):
    return json.loads(response["body"])


def test_lambda_entry_point_keeps_aws_signature():
    assert list(inspect.signature(lambda_function.lambda_handler).parameters) == [
        "event",
        "context",
    ]


def test_lambda_handler_dispatches_injected_handlers():
    records = []
    handlers = {
        "authorizer": lambda event, context: {"kind": "auth"},
        "sqs_handler": records.append,
        "websocket_handler": lambda event, context: {"kind": "ws"},
        "http_handler": lambda event: {"kind": "http"},
    }

    assert lambda_function.dispatch_event(
        {"type": "REQUEST", "methodArn": "arn"}, None, **handlers
    ) == {"kind": "auth"}
    sqs_event = {
        "Records": [
            {"eventSource": "aws:sqs", "messageId": "one"},
            {"eventSource": "other", "messageId": "two"},
        ]
    }
    assert lambda_function.dispatch_event(sqs_event, None, **handlers)["statusCode"] == 200
    assert [record["messageId"] for record in records] == ["one"]
    assert lambda_function.dispatch_event(
        {"requestContext": {"connectionId": "c"}}, None, **handlers
    ) == {"kind": "ws"}
    assert lambda_function.dispatch_event(
        {"path": "/health"}, None, **handlers
    ) == {"kind": "http"}
    assert lambda_function.dispatch_event([], None)["statusCode"] == 400


def test_websocket_connect_and_disconnect_broadcast(monkeypatch):
    deleted, posts = [], []
    table = SimpleNamespace(
        get_item=lambda **kwargs: {
            "Item": {"room_code": "ROOM", "client_id": "p1", "role": "player"}
        },
        delete_item=lambda **kwargs: deleted.append(kwargs),
        query=lambda **kwargs: {"Items": [{"connection_id": "other"}]},
    )
    monkeypatch.setattr(lambda_function, "connections_table", table)
    monkeypatch.setattr(
        lambda_function.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            post_to_connection=lambda **kwargs: posts.append(kwargs)
        ),
    )
    base_context = {
        "connectionId": "self",
        "domainName": "example",
        "stage": "dev",
    }
    assert lambda_function.handle_websocket({}, {**base_context, "routeKey": "$connect"})["body"] == "Connected."
    result = lambda_function.handle_websocket({}, {**base_context, "routeKey": "$disconnect"})
    assert result["body"] == "Disconnected."
    assert deleted == [{"Key": {"connection_id": "self"}}]
    assert json.loads(posts[0]["Data"])["type"] == "user_left"


def test_websocket_signal_unicast_and_missing_sender(monkeypatch):
    posts = []
    sender = {"client_id": "p1", "role": "player", "room_code": "ROOM"}
    table = SimpleNamespace(
        get_item=lambda **kwargs: {"Item": sender},
        query=lambda **kwargs: {
            "Items": [
                {"connection_id": "one", "client_id": "p2"},
                {"connection_id": "two", "client_id": "viewer"},
            ]
        },
    )
    monkeypatch.setattr(lambda_function, "connections_table", table)
    monkeypatch.setattr(
        lambda_function.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            post_to_connection=lambda **kwargs: posts.append(kwargs)
        ),
    )
    context = {
        "connectionId": "self",
        "routeKey": "message",
        "domainName": "example",
        "stage": "dev",
    }
    event = {"body": json.dumps({"action": "signal", "type": "offer", "data": {}, "to": "p2"})}
    assert lambda_function.handle_websocket(event, context)["statusCode"] == 200
    assert [call["ConnectionId"] for call in posts] == ["one"]

    table.get_item = lambda **kwargs: {}
    assert lambda_function.handle_websocket(event, context)["statusCode"] == 404


def test_websocket_action_failure_returns_controlled_error(monkeypatch):
    table = SimpleNamespace(
        put_item=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("write failed"))
    )
    monkeypatch.setattr(lambda_function, "connections_table", table)
    monkeypatch.setattr(
        lambda_function.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(post_to_connection=lambda **kwargs: None),
    )
    response = lambda_function.handle_websocket(
        {"body": json.dumps({"action": "join_room"})},
        {
            "connectionId": "self",
            "routeKey": "message",
            "domainName": "example",
            "stage": "dev",
        },
    )
    assert response == {"statusCode": 500, "body": "WebSocket action failed"}


def test_register_room_log_and_unknown_routes(monkeypatch):
    puts = []
    monkeypatch.setattr(
        lambda_function,
        "sessions_table",
        SimpleNamespace(put_item=lambda **kwargs: puts.append(kwargs)),
    )
    registered = lambda_function.handle_http(
        {
            "path": "/api/register-room",
            "httpMethod": "POST",
            "body": json.dumps({"sessionId": "s", "roomCode": "R", "signalingUrl": "wss://x"}),
        }
    )
    assert registered["statusCode"] == 200
    assert puts[0]["Item"]["room_code"] == "R"
    assert lambda_function.handle_http(
        {"path": "/api/log", "httpMethod": "POST", "body": '{"message":"hello"}'}
    )["statusCode"] == 200
    assert lambda_function.handle_http({"path": "/missing"})["statusCode"] == 404


def test_webcam_upload_and_snapshot_routes(monkeypatch):
    calls = []

    class ClientError(Exception):
        pass

    s3 = SimpleNamespace(
        exceptions=SimpleNamespace(ClientError=ClientError),
        put_object=lambda **kwargs: calls.append(kwargs),
        head_object=lambda **kwargs: None,
    )
    monkeypatch.setenv("PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setenv("PHOTOS_S3_DOMAIN", "cdn.example")
    monkeypatch.setattr(lambda_function.boto3, "client", lambda *args, **kwargs: s3)
    monkeypatch.setattr(
        lambda_function,
        "sessions_table",
        SimpleNamespace(update_item=lambda **kwargs: calls.append(kwargs)),
    )
    encoded = base64.b64encode(b"jpeg").decode()
    upload = lambda_function.handle_http(
        {
            "path": "/api/webcam-upload",
            "httpMethod": "POST",
            "body": json.dumps(
                {"sessionId": "s", "role": "player2", "image": f"data:image/jpeg;base64,{encoded}"}
            ),
        }
    )
    assert _body(upload)["url"] == "https://cdn.example/webcam_snapshots/s/player2.jpg"
    snapshot = lambda_function.handle_http(
        {
            "path": "/api/get-snapshot",
            "httpMethod": "GET",
            "queryStringParameters": {"sessionId": "s", "role": "player2"},
        }
    )
    assert _body(snapshot)["success"] is True


def test_get_snapshot_returns_waiting_when_object_missing(monkeypatch):
    class ClientError(Exception):
        pass

    s3 = SimpleNamespace(
        exceptions=SimpleNamespace(ClientError=ClientError),
        head_object=lambda **kwargs: (_ for _ in ()).throw(ClientError()),
    )
    monkeypatch.setenv("PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setattr(lambda_function.boto3, "client", lambda *args, **kwargs: s3)
    response = lambda_function.handle_http(
        {"path": "/api/get-snapshot", "httpMethod": "GET", "queryStringParameters": {}}
    )
    assert _body(response)["message"] == "Awaiting snapshot capture"


def test_last_image_success_and_placeholder(monkeypatch):
    monkeypatch.setenv("PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setattr(
        lambda_function.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(head_object=lambda **kwargs: None),
    )
    success = lambda_function.handle_http(
        {
            "path": "/api/last-image",
            "httpMethod": "GET",
            "queryStringParameters": {"session_id": "s", "role": "player1"},
        }
    )
    assert "webcam_snapshots/s/player1.jpg" in success["body"]
    monkeypatch.delenv("PHOTOS_S3_BUCKET")
    missing = lambda_function.handle_http(
        {"path": "/api/last-image", "httpMethod": "GET"}
    )
    assert "No webcam frame uploaded yet" in missing["body"]


def test_live_status_generates_commentary_audio_and_gateway_calls(monkeypatch):
    gateway_calls = []
    monkeypatch.setattr(commentary, "translate_detail", lambda text: f"translated:{text}")
    monkeypatch.setattr(commentary, "generate_ai_commentary", lambda **kwargs: "Great fight!")
    monkeypatch.setattr(
        commentary_tts,
        "synthesize_commentary_audio",
        lambda **kwargs: {"audioUrl": "https://audio", "duration": 1.0},
    )
    monkeypatch.setattr(
        lambda_function,
        "invoke_agentcore_gateway_tool",
        lambda **kwargs: gateway_calls.append(kwargs),
    )
    response = lambda_function.handle_http(
        {
            "path": "/api/live-status",
            "httpMethod": "POST",
            "body": json.dumps(
                {
                    "sessionId": "s",
                    "text": "robot_1 scored",
                    "agent_type": "agentcore_runtime",
                    "agentImagePolicy": "never",
                    "ttsMode": "aws",
                    "lang": "en",
                }
            ),
        }
    )
    body = _body(response)
    assert body["commentary"] == "Great fight!"
    assert body["ttsMode"] == "aws"
    assert body["audioUrl"] == "https://audio"
    assert gateway_calls[0]["arguments"]["message"] == "Great fight!"


def test_battle_result_marks_reset_and_falls_back_to_browser_tts(monkeypatch):
    monkeypatch.setattr(commentary, "translate_detail", lambda text: text)
    monkeypatch.setattr(commentary, "generate_ai_commentary", lambda **kwargs: "Winner!")
    monkeypatch.setattr(commentary_tts, "synthesize_commentary_audio", lambda **kwargs: None)
    monkeypatch.setattr(lambda_function, "invoke_agentcore_gateway_tool", lambda **kwargs: None)
    response = lambda_function.handle_http(
        {
            "path": "/api/battle-result",
            "httpMethod": "POST",
            "body": json.dumps(
                {"agent_type": "strands_local", "agentImagePolicy": "never", "ttsMode": "aws"}
            ),
        }
    )
    body = _body(response)
    assert body["isReset"] if "isReset" in body else body["debugImageContext"]["isReset"]
    assert body["welcomeMessage"] == "Winner!"
    assert body["ttsMode"] == "browser"


def test_trigger_technique_targets_team_and_calls_speech_and_action(monkeypatch):
    calls = []
    monkeypatch.setattr(
        lambda_function,
        "invoke_agentcore_gateway_tool",
        lambda **kwargs: calls.append(kwargs),
    )
    response = lambda_function.handle_http(
        {
            "path": "/api/trigger-technique",
            "httpMethod": "POST",
            "body": json.dumps(
                {"technique": "domain_unlimited_void", "robotId": "all", "role": "player1"}
            ),
        }
    )
    body = _body(response)
    assert body["targets"] == ["robot_1", "robot_2", "robot_3"]
    assert body["triggered_targets"] == body["targets"]
    assert len(calls) == 6


def test_gateway_tool_no_url_success_and_failure(monkeypatch):
    monkeypatch.delenv("McpServerGatewayUrl", raising=False)
    assert lambda_function.invoke_agentcore_gateway_tool("tool", {}) is None

    import botocore.session
    import botocore.auth
    import requests

    credentials = SimpleNamespace(get_frozen_credentials=lambda: SimpleNamespace())
    fake_session = SimpleNamespace(
        get_credentials=lambda: credentials,
        get_config_variable=lambda _name: "us-east-1",
    )
    monkeypatch.setenv("McpServerGatewayUrl", "https://gateway.example")
    monkeypatch.setattr(botocore.session, "Session", lambda: fake_session)
    monkeypatch.setattr(
        botocore.auth,
        "SigV4Auth",
        lambda *args, **kwargs: SimpleNamespace(add_auth=lambda request: None),
    )
    monkeypatch.setattr(
        requests,
        "post",
        lambda *args, **kwargs: SimpleNamespace(status_code=200, text="ok"),
    )
    assert lambda_function.invoke_agentcore_gateway_tool("tool", {"x": 1}) == "ok"
    monkeypatch.setattr(
        requests,
        "post",
        lambda *args, **kwargs: SimpleNamespace(status_code=500, text="bad"),
    )
    with pytest.raises(RuntimeError, match="HTTP 500"):
        lambda_function.invoke_agentcore_gateway_tool("tool", {})


def test_live_status_attaches_both_s3_images(monkeypatch):
    class Body:
        def read(self):
            return b"image"

    monkeypatch.setenv("PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setattr(
        lambda_function.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            get_object=lambda **kwargs: {"Body": Body()}
        ),
    )
    monkeypatch.setattr(lambda_function, "optimize_commentary_image", lambda data: data + b"-optimized")
    captured = {}
    monkeypatch.setattr(commentary, "translate_detail", lambda text: text)
    monkeypatch.setattr(
        commentary,
        "generate_ai_commentary",
        lambda **kwargs: captured.update(kwargs) or "commentary",
    )
    monkeypatch.setattr(lambda_function, "invoke_agentcore_gateway_tool", lambda **kwargs: None)
    response = lambda_function.handle_http(
        {
            "path": "/api/live-status",
            "httpMethod": "POST",
            "body": json.dumps(
                {
                    "text": "action",
                    "agent_type": "agentcore_runtime",
                    "agentImagePolicy": "always",
                    "lang": "ja-JP",
                }
            ),
        }
    )
    assert response["statusCode"] == 200
    assert captured["image_bytes_p1"] == b"image-optimized"
    assert captured["image_bytes_p2"] == b"image-optimized"
    assert _body(response)["debugImageContext"]["hasImageP1"] is True


def test_enhancement_and_upload_database_failures(monkeypatch):
    monkeypatch.setattr(
        lambda_function,
        "sessions_table",
        SimpleNamespace(
            update_item=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("db down"))
        ),
    )
    enhance = lambda_function.handle_http(
        {"path": "/api/enhance-portrait", "httpMethod": "POST", "body": "{}"}
    )
    assert enhance["statusCode"] == 500
    monkeypatch.delenv("PHOTOS_S3_BUCKET", raising=False)
    upload = lambda_function.handle_http(
        {
            "path": "/api/webcam-upload",
            "httpMethod": "POST",
            "body": json.dumps({"image": base64.b64encode(b"x").decode()}),
        }
    )
    assert upload["statusCode"] == 500
