import asyncio
from types import SimpleNamespace

import pytest

from services import strands_service_mcp


def test_patched_message_stop_filters_grounding(monkeypatch):
    assert (
        strands_service_mcp._patched_handle_message_stop(
            {"stopReason": "tool_use"},
            [{"toolUse": {"name": "nova_grounding"}}],
        )
        == "end_turn"
    )
    assert (
        strands_service_mcp._patched_handle_message_stop(
            {"stopReason": "end_turn"},
            [{"toolUse": {"name": "robot_wave"}}],
        )
        == "tool_use"
    )
    monkeypatch.setattr(
        strands_service_mcp,
        "_original_handle_message_stop",
        lambda event, content: "original",
    )
    assert strands_service_mcp._patched_handle_message_stop({}, []) == "original"


def test_create_robot_agent_with_injected_boundaries(monkeypatch):
    class MCP:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def list_tools(self):
            return ["tool"]

    captured = {}
    monkeypatch.setattr(strands_service_mcp, "get_mcp_client", lambda: MCP())
    monkeypatch.setattr(
        strands_service_mcp,
        "FileSessionManager",
        lambda **kwargs: ("session", kwargs),
    )
    monkeypatch.setattr(
        strands_service_mcp,
        "Agent",
        lambda **kwargs: captured.update(kwargs) or SimpleNamespace(),
    )
    asyncio.run(strands_service_mcp.create_robot_agent_with_mcp("session", "BACKGROUND"))
    assert captured["tools"] == ["tool"]
    assert "BACKGROUND" in captured["system_prompt"]


def test_create_robot_agent_requires_configured_url(monkeypatch):
    monkeypatch.setattr(strands_service_mcp.config, "MCP_SERVER_URL", "")
    with pytest.raises(ValueError, match="not configured"):
        asyncio.run(strands_service_mcp.create_robot_agent("session"))


def test_grounded_model_adds_tool_and_cleans_history(monkeypatch):
    class MCP:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def list_tools(self):
            return []

    captured = {}
    monkeypatch.setattr(strands_service_mcp, "get_mcp_client", lambda: MCP())
    monkeypatch.setattr(strands_service_mcp, "FileSessionManager", lambda **kwargs: object())
    monkeypatch.setattr(
        strands_service_mcp,
        "Agent",
        lambda **kwargs: captured.update(kwargs) or SimpleNamespace(),
    )
    monkeypatch.setattr(
        strands_service_mcp.BedrockModel,
        "format_request",
        lambda self, *args, **kwargs: {
            "toolConfig": {"tools": []},
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "toolUse": {
                                "name": "nova_grounding",
                                "toolUseId": "ground",
                            }
                        },
                        {"text": "kept"},
                    ],
                },
                {
                    "role": "assistant",
                    "content": [{"citationsContent": {"citations": []}}],
                },
                {
                    "role": "user",
                    "content": [
                        {"toolResult": {"toolUseId": "ground"}},
                        {"text": "question"},
                    ],
                },
            ],
        },
    )
    asyncio.run(
        strands_service_mcp.create_robot_agent_with_mcp(
            "session",
            enable_grounding=True,
        )
    )
    request = captured["model"].format_request([])
    assert request["toolConfig"]["tools"] == [
        {"systemTool": {"name": "nova_grounding"}}
    ]
    assert request["messages"] == [
        {"role": "assistant", "content": [{"text": "kept"}]},
        {"role": "user", "content": [{"text": "question"}]},
    ]


def test_create_robot_agent_uses_mcp_when_configured(monkeypatch):
    expected = object()
    monkeypatch.setattr(strands_service_mcp.config, "MCP_SERVER_URL", "https://gateway")

    async def create(*args):
        return expected

    monkeypatch.setattr(strands_service_mcp, "create_robot_agent_with_mcp", create)
    assert asyncio.run(strands_service_mcp.create_robot_agent("session")) is expected
