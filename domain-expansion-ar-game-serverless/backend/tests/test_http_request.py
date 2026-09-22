import pytest

from http_request import (
    LiveStatusRequest,
    build_commentary_prompt,
    build_technique_plan,
    normalize_session_id,
    parse_json_body,
    snapshot_role_key,
    summarize_event,
)


def test_parse_json_body_preserves_valid_values_and_handles_invalid_input():
    assert parse_json_body({"body": '{"value": 1}'}) == {"value": 1}
    assert parse_json_body({"body": "[1, 2]"}) == {}
    assert parse_json_body({"body": "invalid"}) == {}
    assert parse_json_body({}) == {}


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, "mcpserver"), (" ", "mcpserver"), (7, "mcpserver"), (" session ", "session")],
)
def test_normalize_session_id(value, expected):
    assert normalize_session_id(value) == expected


@pytest.mark.parametrize(
    ("role", "expected"),
    [("player1", "player1"), ("player2", "player2"), ("spectator", "viewer")],
)
def test_snapshot_role_key(role, expected):
    assert snapshot_role_key(role) == expected


@pytest.mark.parametrize(
    ("path", "body", "marker", "attach"),
    [
        (
            "/api/live-status",
            {"text": "hit", "agentImagePolicy": "never"},
            "[MID-MATCH EVENT ENCOUNTERED]",
            False,
        ),
        (
            "/api/live-status",
            {"detail": "ready", "eventType": "RESET", "agentImagePolicy": "start_end"},
            "[MATCH INITIAL GREETING]",
            True,
        ),
        (
            "/api/battle-result",
            {"p1Score": 3, "p2Score": 2, "foulLanguage": True},
            "[BATTLE CONCLUSION TRIGGERED]",
            True,
        ),
    ],
)
def test_live_status_request_and_prompt_variants(path, body, marker, attach):
    request = LiveStatusRequest.from_body(body, path, "agentcore_runtime")
    prompt = build_commentary_prompt(request, "translated")
    assert marker in prompt
    if marker != "[MATCH INITIAL GREETING]":
        assert "translated" in prompt
    assert request.should_attach_image is attach


@pytest.mark.parametrize(
    ("language", "expected"),
    [("zh-CN", "廣東話"), ("ja-JP", "日本語"), ("fr", "English")],
)
def test_commentary_prompt_language_fallbacks(language, expected):
    request = LiveStatusRequest.from_body(
        {"lang": language}, "/api/live-status", "agentcore_runtime"
    )
    assert expected in build_commentary_prompt(request, "event")


def test_live_status_request_normalizes_tts_and_engine():
    request = LiveStatusRequest.from_body(
        {"ttsMode": " INVALID ", "agent_type": "openclaw"},
        "/api/live-status",
        "agentcore_runtime",
    )
    assert request.requested_tts_mode == "browser"
    assert request.agent_engine == "openclaw"


@pytest.mark.parametrize(
    ("body", "targets", "tool", "speech"),
    [
        (
            {"technique": "domain_unlimited_void", "robotId": "all", "role": "player1"},
            ["robot_1", "robot_2", "robot_3"],
            "robot_kung_fu",
            "領域展開、無量空処",
        ),
        (
            {"technique": "hollow_purple", "robotId": "all", "role": "player2"},
            ["robot_4", "robot_5", "robot_6"],
            "robot_left_kick",
            "虚式、茈",
        ),
        (
            {"technique": "custom", "robotId": "all"},
            ["robot_1"],
            "robot_custom",
            None,
        ),
        (
            {"technique": "custom", "robotId": "robot_5"},
            ["robot_5"],
            "robot_custom",
            None,
        ),
    ],
)
def test_build_technique_plan(body, targets, tool, speech):
    plan = build_technique_plan(body)
    assert plan.targets == targets
    assert plan.mcp_tool_name == tool
    assert plan.speech == speech
