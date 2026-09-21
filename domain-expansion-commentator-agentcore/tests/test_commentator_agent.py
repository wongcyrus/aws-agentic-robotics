import base64
import logging
import sys
from types import ModuleType

import pytest
from fastapi.testclient import TestClient

import commentator_agent


class FakeAgent:
    instances = []
    response = "generated commentary"
    error = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.invocations = []
        self.__class__.instances.append(self)

    async def invoke_async(self, message):
        self.invocations.append(message)
        if self.error:
            raise self.error
        return self.response


class FakeBedrockModel:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture(autouse=True)
def fake_strands(monkeypatch):
    FakeAgent.instances.clear()
    FakeAgent.error = None
    strands = ModuleType("strands")
    strands.Agent = FakeAgent
    models = ModuleType("strands.models")
    models.BedrockModel = FakeBedrockModel
    monkeypatch.setitem(sys.modules, "strands", strands)
    monkeypatch.setitem(sys.modules, "strands.models", models)


@pytest.fixture
def client():
    with TestClient(commentator_agent.app) as test_client:
        yield test_client


def test_endpoint_filter_drops_health_checks():
    filter_obj = commentator_agent.EndpointFilter()
    assert filter_obj.filter(logging.LogRecord("x", 20, "", 1, "%s %s %s", ("GET", 200, "/ping"), None)) is False
    assert filter_obj.filter(logging.LogRecord("x", 20, "", 1, "%s %s %s", ("POST", 200, "/invoke"), None)) is True


def test_load_system_prompt_reads_packaged_prompts():
    prompt = commentator_agent.load_system_prompt()
    assert "Nobara Kugisaki" in prompt
    assert "Commentary" in prompt


def test_health_check(client):
    response = client.get("/ping")
    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "service": "jjk-commentator-agentcore",
    }


@pytest.mark.parametrize("path", ["/invocations", "/invoke", "/"])
def test_all_invocation_routes_accept_prompt(client, path):
    response = client.post(path, json={"prompt": "Fight!", "session_id": "session"})
    assert response.status_code == 200
    assert response.json() == {"response": "generated commentary"}
    assert FakeAgent.instances[-1].invocations == ["Fight!"]


def test_missing_prompt_returns_400_without_model_call(client):
    response = client.post("/invoke", json={})
    assert response.status_code == 400
    assert response.json()["error"] == "Prompt field is required."
    assert FakeAgent.instances == []


def test_extracts_text_from_openclaw_messages(client):
    response = client.post(
        "/invoke",
        json={
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "First"},
                        {"type": "text", "text": "Second"},
                    ],
                }
            ]
        },
    )
    assert response.status_code == 200
    assert FakeAgent.instances[-1].invocations == ["First\nSecond"]


def test_xml_images_are_removed_from_prompt_and_attached(client):
    p1 = base64.b64encode(b"player-one").decode()
    p2 = base64.b64encode(b"player-two").decode()
    prompt = (
        f"Battle now <p1_webcam_base64_jpeg>{p1}</p1_webcam_base64_jpeg>"
        f"<p2_webcam_base64_jpeg>{p2}</p2_webcam_base64_jpeg>"
    )
    response = client.post("/invoke", json={"prompt": prompt})
    invocation = FakeAgent.instances[-1].invocations[0]

    assert response.status_code == 200
    assert invocation[-1] == {"text": "Battle now"}
    assert invocation[1]["image"]["source"]["bytes"] == b"player-one"
    assert invocation[3]["image"]["source"]["bytes"] == b"player-two"


def test_extracts_data_url_images_from_message_blocks(client):
    encoded = base64.b64encode(b"image").decode()
    response = client.post(
        "/invoke",
        json={
            "message": [
                {"type": "text", "text": "Attack"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpg;base64,{encoded}"},
                },
            ]
        },
    )
    invocation = FakeAgent.instances[-1].invocations[0]

    assert response.status_code == 200
    assert invocation[1]["image"]["format"] == "jpeg"
    assert invocation[1]["image"]["source"]["bytes"] == b"image"
    assert invocation[-1] == {"text": "Attack"}


def test_model_error_returns_500(client):
    FakeAgent.error = RuntimeError("model unavailable")
    response = client.post("/invoke", json={"prompt": "Fight!"})
    assert response.status_code == 500
    assert response.json() == {"error": "model unavailable"}


def test_invalid_base64_returns_500(client):
    response = client.post("/invoke", json={"prompt": "Fight!", "image": "a"})
    assert response.status_code == 500
    assert "error" in response.json()
