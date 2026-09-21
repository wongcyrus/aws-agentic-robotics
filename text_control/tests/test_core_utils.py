from unittest.mock import Mock

import pytest

from services import database_service
from services.message_transformer import MessageTransformer
from utils.command_normalization import find_matching_command, normalize_command
from utils.messages import WELCOME_MESSAGES, get_message
from utils.response_utils import create_response_object, create_stream_chunk


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("moveForward", "move_forward"),
        (" move  forward ", "move_forward"),
        ("__PushUps__", "push_ups"),
        (None, ""),
    ],
)
def test_normalize_command(raw, expected):
    assert normalize_command(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("MOVE_FORWARD", "move_forward"), ("moveForward", "move_forward"), ("back", "move_backward")],
)
def test_find_matching_command(raw, expected):
    assert find_matching_command(raw, {"move_forward", "move_backward"}) == expected


def test_find_matching_command_returns_none_for_unknown():
    assert find_matching_command("teleport", {"move_forward"}) is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("moveForward", "move_forward"), ("_AlreadySnake", "already_snake"), ("ABC", "a_b_c")],
)
def test_camel_to_snake_case(raw, expected):
    assert MessageTransformer.camel_to_snake_case(raw) == expected


def test_message_transformer_prefix_helpers():
    assert MessageTransformer.remove_prefix("robotMove", "robot") == "Move"
    assert MessageTransformer.remove_prefix("droneMove", "robot") is None
    assert MessageTransformer.has_device_prefix("droneTakeoff", "robot") is True
    assert MessageTransformer.has_device_prefix("dronefly", "robot") is False


def test_get_message_uses_requested_then_fallback_language():
    assert get_message(WELCOME_MESSAGES, "en").startswith("Hello")
    assert get_message(WELCOME_MESSAGES, "fr").startswith("你好")
    assert get_message({}, "fr") == ""


def test_database_service_adds_default_name(monkeypatch):
    mocked = Mock(side_effect=lambda robot_id, data: {"id": robot_id, **data})
    monkeypatch.setattr(database_service, "db_upsert_robot", mocked)
    data = {"ip": "127.0.0.1"}

    result = database_service.upsert_robot("r1", data)

    assert result["robot_name"] == "Unknown"
    mocked.assert_called_once_with("r1", data)


def test_database_service_error_fallbacks(monkeypatch):
    failure = Mock(side_effect=RuntimeError("database unavailable"))
    monkeypatch.setattr(database_service, "db_get_robot", failure)
    monkeypatch.setattr(database_service, "db_delete_robot", failure)
    monkeypatch.setattr(database_service, "db_list_robots", failure)

    assert database_service.get_robot("r1") is None
    assert database_service.delete_robot("r1") is False
    assert database_service.list_robots() == []


def test_response_builders_preserve_contract(monkeypatch):
    monkeypatch.setattr("utils.response_utils.uuid.uuid4", lambda: "fixed-id")
    monkeypatch.setattr("utils.response_utils.time.time", lambda: 1.5)
    params = {
        "ask_text": "hello",
        "extra": {"a": 1},
        "session_id": "session",
        "trace_id": "trace",
    }

    response = create_response_object(params, "reply")
    chunk = create_stream_chunk("hello", {}, "trace", "session", "part", False, "chunk")

    assert response["id"] == "fixed-id"
    assert response["timestamp"] == 1500
    assert response["replyText"] == "reply"
    assert chunk["id"] == "chunk"
    assert chunk["isFinal"] is False
