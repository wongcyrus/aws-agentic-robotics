import io
import json
import sys
from types import ModuleType
from types import SimpleNamespace

import pytest

import commentary


def test_build_openclaw_content_returns_text_without_images():
    assert commentary._build_openclaw_content_block("prompt", "", "jpeg", "", "jpeg") == "prompt"


def test_build_openclaw_content_adds_both_images():
    content = commentary._build_openclaw_content_block("prompt", "one", "jpg", "two", "png")
    assert content[0] == {"type": "text", "text": "prompt"}
    assert content[2]["image_url"]["url"] == "data:image/jpg;base64,one"
    assert content[4]["image_url"]["url"] == "data:image/png;base64,two"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ("plain", "plain"),
        ({"response": "response"}, "response"),
        ({"output": "output"}, "output"),
        ({"message": {"content": "message"}}, "message"),
        ({"choices": [{"message": {"content": "choice"}}]}, "choice"),
        ({"choices": [{"message": {"content": [{"text": "a"}, {"text": "b"}]}}]}, "a b"),
        ({"choices": [{"text": "legacy"}]}, "legacy"),
        ({"response": {"text": "nested"}}, "nested"),
        ({}, ""),
    ],
)
def test_extract_agentcore_commentary(payload, expected):
    assert commentary._extract_agentcore_commentary(payload) == expected


def test_translate_detail_replaces_robot_actions_and_scores():
    translated = commentary.translate_detail(
        "robot_1 used robotMoveForward. Player 1 scored!"
    )
    assert "Fushiguro Megumi" in translated
    assert "advances into close-combat range" in translated
    assert "P1 成功得分" in translated


@pytest.mark.parametrize(
    ("language", "phrase"),
    [("zh-HK", "廣東話"), ("zh-TW", "繁體中文"), ("ja", "日本語"), ("en", "English")],
)
def test_load_system_prompt_applies_language_rule(language, phrase):
    assert phrase in commentary.load_system_prompt(language)


def test_direct_bedrock_fallback_builds_multimodal_request(monkeypatch):
    client = SimpleNamespace(
        converse=lambda **kwargs: {
            "output": {"message": {"content": [{"text": "generated"}]}}
        }
    )
    monkeypatch.setattr(commentary.boto3, "client", lambda *args, **kwargs: client)

    result = commentary.direct_bedrock_fallback(
        "prompt", b"p1", "jpg", b"p2", "png", language="en"
    )

    assert result == "generated"


def test_direct_bedrock_fallback_returns_stable_message_on_failure(monkeypatch):
    monkeypatch.setattr(
        commentary.boto3, "client", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
    )
    assert "Cursed Energy connection unstable" in commentary.direct_bedrock_fallback("prompt")


def test_resolve_agentcore_identity_is_stable(monkeypatch):
    monkeypatch.setenv("AGENTCORE_ACTOR_ID", "telegram:user")
    first = commentary.resolve_agentcore_identity("one", "arn")
    second = commentary.resolve_agentcore_identity("two", "arn")
    assert first == second
    assert first[0] == "telegram:user"
    assert first[1].startswith("dashboard-user-")


def test_generate_agentcore_commentary_parses_response(monkeypatch):
    response = {"response": io.BytesIO(json.dumps({"response": "runtime answer"}).encode())}
    client = SimpleNamespace(invoke_agent_runtime=lambda **kwargs: response)
    monkeypatch.setattr(commentary.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")

    result = commentary.generate_ai_commentary(
        "agentcore_runtime", "fight", session_id="session", image_bytes_p1=b"image"
    )

    assert result == "runtime answer"


def test_generate_agentcore_commentary_falls_back_on_runtime_error(monkeypatch):
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            invoke_agent_runtime=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
        ),
    )
    monkeypatch.setattr(commentary, "direct_bedrock_fallback", lambda *args, **kwargs: "fallback")
    assert commentary.generate_ai_commentary("agentcore_runtime", "fight") == "fallback"


def test_generate_strands_local_multimodal_commentary(monkeypatch):
    invocations = []

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def invoke_async(self, message):
            invocations.append(message)
            return "local answer"

    strands = ModuleType("strands")
    strands.Agent = Agent
    models = ModuleType("strands.models")
    models.BedrockModel = lambda **kwargs: object()
    monkeypatch.setitem(sys.modules, "strands", strands)
    monkeypatch.setitem(sys.modules, "strands.models", models)

    result = commentary.generate_ai_commentary(
        "strands_local",
        "fight",
        image_bytes_p1=b"one",
        image_format_p1="jpg",
        image_bytes_p2=b"two",
    )
    assert result == "local answer"
    assert invocations[0][2]["image"]["format"] == "jpeg"
    assert invocations[0][-1]["image"]["source"]["bytes"] == b"two"


def test_generate_strands_local_falls_back(monkeypatch):
    strands = ModuleType("strands")
    strands.Agent = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
    models = ModuleType("strands.models")
    models.BedrockModel = lambda **kwargs: object()
    monkeypatch.setitem(sys.modules, "strands", strands)
    monkeypatch.setitem(sys.modules, "strands.models", models)
    monkeypatch.setattr(commentary, "direct_bedrock_fallback", lambda *args, **kwargs: "fallback")
    assert commentary.generate_ai_commentary("strands_local", "fight") == "fallback"


def test_generate_openclaw_http_commentary(monkeypatch):
    request_calls = []

    class Response:
        status = 200
        data = json.dumps(
            {"choices": [{"message": {"content": "openclaw answer"}}]}
        ).encode()

    class Pool:
        def request(self, *args, **kwargs):
            request_calls.append((args, kwargs))
            return Response()

    import urllib3

    monkeypatch.setattr(urllib3, "PoolManager", lambda: Pool())
    monkeypatch.setattr(commentary, "OPENCLAW_RUNTIME_ARN", "")
    monkeypatch.setattr(commentary, "AGENTCORE_RUNTIME_ARN", "")
    monkeypatch.delenv("OPENCLAW_RUNTIME_ARN", raising=False)
    monkeypatch.delenv("AGENTCORE_RUNTIME_ARN", raising=False)
    result = commentary.generate_ai_commentary(
        "openclaw", "fight", session_id="telegram:user_session"
    )
    assert result == "openclaw answer"
    assert request_calls[0][0][0] == "POST"


def test_generate_openclaw_http_falls_back_on_status(monkeypatch):
    import urllib3

    monkeypatch.setattr(
        urllib3,
        "PoolManager",
        lambda: SimpleNamespace(
            request=lambda *args, **kwargs: SimpleNamespace(status=503, data=b"")
        ),
    )
    monkeypatch.setattr(commentary, "OPENCLAW_RUNTIME_ARN", "")
    monkeypatch.setattr(commentary, "AGENTCORE_RUNTIME_ARN", "")
    monkeypatch.delenv("OPENCLAW_RUNTIME_ARN", raising=False)
    monkeypatch.delenv("AGENTCORE_RUNTIME_ARN", raising=False)
    monkeypatch.setattr(commentary, "direct_bedrock_fallback", lambda *args, **kwargs: "fallback")
    assert commentary.generate_ai_commentary("openclaw", "fight") == "fallback"
