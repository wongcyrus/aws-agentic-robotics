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


def test_translate_detail_preserves_empty_text():
    assert commentary.translate_detail("") == ""


@pytest.mark.parametrize(
    ("language", "phrase"),
    [("zh-HK", "廣東話"), ("zh-TW", "繁體中文"), ("ja", "日本語"), ("en", "English")],
)
def test_load_system_prompt_applies_language_rule(language, phrase):
    assert phrase in commentary.load_system_prompt(language)


def test_direct_bedrock_commentary_builds_multimodal_request(monkeypatch):
    client = SimpleNamespace(
        converse=lambda **kwargs: {
            "output": {"message": {"content": [{"text": "generated"}]}}
        }
    )
    monkeypatch.setattr(commentary.boto3, "client", lambda *args, **kwargs: client)

    result = commentary.generate_direct_bedrock_commentary(
        "prompt", b"p1", "jpg", b"p2", "png", language="en"
    )

    assert result == "generated"


def test_direct_bedrock_commentary_rejects_truncated_output(monkeypatch):
    calls = []

    def converse(**kwargs):
        calls.append(kwargs["inferenceConfig"]["maxTokens"])
        return {
            "stopReason": "max_tokens",
            "output": {"message": {"content": [{"text": "truncated P2"}]}},
        }

    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(converse=converse),
    )

    with pytest.raises(RuntimeError, match="Direct Bedrock commentary failed"):
        commentary.generate_direct_bedrock_commentary("prompt")
    assert calls == [commentary.COMMENTARY_MAX_TOKENS]


def test_direct_bedrock_commentary_surfaces_failure(monkeypatch):
    monkeypatch.setattr(
        commentary.boto3, "client", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
    )
    with pytest.raises(RuntimeError, match="Direct Bedrock commentary failed"):
        commentary.generate_direct_bedrock_commentary("prompt")


def test_direct_bedrock_commentary_rejects_response_without_text(monkeypatch):
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            converse=lambda **kwargs: {
                "output": {"message": {"content": [{"image": {}}]}}
            }
        ),
    )
    with pytest.raises(RuntimeError, match="Direct Bedrock commentary failed"):
        commentary.generate_direct_bedrock_commentary("prompt")


def test_local_direct_bypasses_agent_runtimes(monkeypatch):
    monkeypatch.setattr(
        commentary,
        "generate_direct_bedrock_commentary",
        lambda *args, **kwargs: "direct commentary",
    )
    assert commentary.generate_ai_commentary("local_direct", "fight") == "direct commentary"


def test_resolve_agentcore_identity_keeps_actor_stable_and_isolates_sessions(monkeypatch):
    monkeypatch.setenv("AGENTCORE_ACTOR_ID", "telegram:user")
    first = commentary.resolve_agentcore_identity("one", "arn")
    same = commentary.resolve_agentcore_identity("one", "arn")
    second = commentary.resolve_agentcore_identity("two", "arn")
    assert first == same
    assert first[0] == "telegram:user"
    assert first[1].startswith("dashboard-user-")
    assert first[:2] == second[:2]
    assert first[2] != second[2]


def test_generate_agentcore_commentary_parses_response(monkeypatch):
    response = {"response": io.BytesIO(json.dumps({"response": "runtime answer"}).encode())}
    client = SimpleNamespace(invoke_agent_runtime=lambda **kwargs: response)
    monkeypatch.setattr(commentary.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")

    result = commentary.generate_ai_commentary(
        "agentcore_runtime", "fight", session_id="session", image_bytes_p1=b"image"
    )

    assert result == "runtime answer"


def test_generate_agentcore_commentary_raises_on_runtime_error(monkeypatch):
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            invoke_agent_runtime=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
        ),
    )
    with pytest.raises(RuntimeError, match="AgentCore runtime failed"):
        commentary.generate_ai_commentary("agentcore_runtime", "fight")


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (json.dumps({"output": "bytes answer"}).encode(), "bytes answer"),
        (json.dumps({"commentary": "string answer"}), "string answer"),
        ([b'{"message":{"content":"', "chunked answer", b'"}}'], "chunked answer"),
        (b"plain runtime answer", "plain runtime answer"),
    ],
)
def test_generate_agentcore_commentary_handles_response_body_variants(
    monkeypatch, body, expected
):
    client = SimpleNamespace(
        invoke_agent_runtime=lambda **kwargs: {"response": body}
    )
    monkeypatch.setattr(commentary.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")

    assert (
        commentary.generate_ai_commentary(
            "agentcore_runtime", "fight", session_id="session"
        )
        == expected
    )


def test_generate_agentcore_commentary_rejects_empty_response(monkeypatch):
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            invoke_agent_runtime=lambda **kwargs: {"response": b"{}"}
        ),
    )
    monkeypatch.setenv("AGENTCORE_RUNTIME_ARN", "arn:runtime")
    with pytest.raises(RuntimeError, match="AgentCore runtime failed"):
        commentary.generate_ai_commentary("agentcore_runtime", "fight")


def test_generate_openclaw_runtime_builds_identity_and_image_payload(monkeypatch):
    calls = []
    client_configs = []
    uploaded = []
    deleted = []
    agent_client = SimpleNamespace(
        invoke_agent_runtime=lambda **kwargs: calls.append(kwargs)
        or {"response": b'{"response":"openclaw runtime answer"}'}
    )
    s3_client = SimpleNamespace(
        put_object=lambda **kwargs: uploaded.append(kwargs),
        delete_object=lambda **kwargs: deleted.append(kwargs),
    )
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda service, **kwargs: (
            client_configs.append(kwargs["config"]) or agent_client
            if service == "bedrock-agentcore"
            else s3_client
        ),
    )
    monkeypatch.setenv("OPENCLAW_RUNTIME_ARN", "arn:openclaw-runtime")
    monkeypatch.setenv("OPENCLAW_SESSION_ID", "stable-session")
    monkeypatch.setattr(commentary, "OPENCLAW_USER_FILES_BUCKET", "openclaw-files")

    result = commentary.generate_ai_commentary(
        "openclaw",
        "fight",
        session_id="dynamic",
        image_bytes_p1=b"one",
        image_format_p1="jpg",
        image_bytes_p2=b"two",
        image_base64_p2="two",
        image_format_p2="png",
    )

    assert result == "openclaw runtime answer"
    payload = json.loads(calls[0]["payload"])
    assert calls[0]["runtimeSessionId"].startswith("dashboard_session_")
    assert payload["session_id"] == calls[0]["runtimeSessionId"]
    assert payload["agentId"] == "main"
    assert payload["model"] == "openclaw/main"
    assert payload["message"]["text"] == "fight"
    assert len(payload["message"]["images"]) == 2
    assert all(image["s3Key"].startswith("stable-session/_uploads/") for image in payload["message"]["images"])
    assert all(image["contentType"] == "image/jpeg" for image in payload["message"]["images"])
    assert "image" not in payload
    assert "image_p2" not in payload
    assert "messages" not in payload
    assert len(uploaded) == 2
    assert [item["Key"] for item in deleted] == [item["Key"] for item in uploaded]
    assert client_configs[0].read_timeout == commentary.AGENTCORE_READ_TIMEOUT_SECONDS
    assert client_configs[0].connect_timeout == 3


def test_openclaw_image_upload_requires_bucket_and_enforces_size(monkeypatch):
    monkeypatch.setattr(commentary, "OPENCLAW_USER_FILES_BUCKET", "")
    with pytest.raises(RuntimeError, match="OPENCLAW_USER_FILES_BUCKET"):
        commentary._upload_openclaw_images("telegram:test", "session", b"one", None)

    monkeypatch.setattr(commentary, "OPENCLAW_USER_FILES_BUCKET", "openclaw-files")
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            put_object=lambda **kwargs: None,
            delete_object=lambda **kwargs: None,
        ),
    )
    with pytest.raises(ValueError, match="3.75 MB"):
        commentary._upload_openclaw_images(
            "telegram:test", "session", b"x" * 3_750_001, None
        )


def test_generate_openclaw_timeout_does_not_fallback(monkeypatch):
    monkeypatch.setenv("OPENCLAW_RUNTIME_ARN", "arn:openclaw-runtime")
    monkeypatch.setattr(
        commentary.boto3,
        "client",
        lambda *args, **kwargs: SimpleNamespace(
            invoke_agent_runtime=lambda **kwargs: (_ for _ in ()).throw(TimeoutError("slow"))
        ),
    )
    monkeypatch.setattr(
        commentary,
        "generate_direct_bedrock_commentary",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("OpenClaw must not fall back")
        ),
    )

    with pytest.raises(RuntimeError, match="OpenClaw runtime failed"):
        commentary.generate_ai_commentary(
            "openclaw",
            "fight",
            session_id="match-one",
            image_base64_p1="encoded-image",
        )


def test_generate_agentcore_without_runtime_arn_raises(monkeypatch):
    monkeypatch.setattr(commentary, "AGENTCORE_RUNTIME_ARN", "")
    monkeypatch.delenv("AGENTCORE_RUNTIME_ARN", raising=False)
    with pytest.raises(RuntimeError, match="AgentCore runtime failed"):
        commentary.generate_ai_commentary("agentcore_runtime", "fight")


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


def test_generate_strands_local_raises(monkeypatch):
    strands = ModuleType("strands")
    strands.Agent = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("down"))
    models = ModuleType("strands.models")
    models.BedrockModel = lambda **kwargs: object()
    monkeypatch.setitem(sys.modules, "strands", strands)
    monkeypatch.setitem(sys.modules, "strands.models", models)
    with pytest.raises(RuntimeError, match="Strands Local commentary failed"):
        commentary.generate_ai_commentary("strands_local", "fight")


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


def test_generate_openclaw_http_raises_on_status(monkeypatch):
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
    with pytest.raises(RuntimeError, match="OpenClaw gateway failed"):
        commentary.generate_ai_commentary("openclaw", "fight")
