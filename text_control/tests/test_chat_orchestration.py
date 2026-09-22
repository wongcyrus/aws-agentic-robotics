import asyncio
import json
from datetime import datetime

from services.chat_orchestration import (
    RobotPromptContext,
    StreamRequest,
    build_stream_error,
    create_agent_stream,
)


def test_robot_prompt_context_normalizes_records():
    assert RobotPromptContext.from_record(None).as_prompt_block() == ""
    context = RobotPromptContext.from_record(
        {"robot_name": "Atlas", "context": "Helps visitors"}
    )
    assert context.name == "Atlas"
    assert "Your Name:Atlas" in context.as_prompt_block()
    assert "Helps visitors" in context.as_prompt_block()


def test_build_stream_error_has_stable_contract():
    request = StreamRequest("hello", "session", "trace", {"replyPayload": "x"})
    chunk = build_stream_error(
        request,
        RuntimeError("offline"),
        include_generated_id=True,
        now=lambda: datetime.fromtimestamp(2),
        id_factory=lambda: "generated",
    )
    payload = json.loads(chunk.removeprefix("data: "))
    assert payload == {
        "askText": "hello",
        "extra": {"replyPayload": "x"},
        "traceId": "trace",
        "replyPayload": None,
        "replyText": "Error: offline",
        "replyType": "Error",
        "sessionId": "session",
        "timestamp": 2000,
        "isFinal": True,
        "id": "generated",
    }


def test_stream_request_from_params_normalizes_values():
    assert StreamRequest.from_params(
        {"ask_text": 3, "session_id": 4, "trace_id": 5, "extra": None}
    ) == StreamRequest("3", "4", "5", {})


def test_create_agent_stream_injects_dependencies():
    calls = []

    async def agent_factory(session_id, background, **kwargs):
        calls.append((session_id, background, kwargs))
        return object()

    async def response_streamer(agent, ask_text, session_id, trace_id, extra):
        yield "one"
        yield "two"

    def sync_wrapper(async_generator):
        async def collect():
            return [item async for item in async_generator]

        return iter(asyncio.run(collect()))

    result = list(
        create_agent_stream(
            StreamRequest("hello", "session", "trace"),
            "background",
            agent_factory=agent_factory,
            response_streamer=response_streamer,
            sync_wrapper=sync_wrapper,
            enable_grounding=True,
        )
    )
    assert result == ["one", "two"]
    assert calls == [("session", "background", {"enable_grounding": True})]


def test_create_agent_stream_converts_failures_to_sse():
    errors = []

    def failing_wrapper(_generator):
        raise RuntimeError("failed")

    chunks = list(
        create_agent_stream(
            StreamRequest("hello", "session", "trace"),
            "",
            agent_factory=None,
            response_streamer=None,
            sync_wrapper=failing_wrapper,
            on_error=errors.append,
        )
    )
    assert errors and str(errors[0]) == "failed"
    assert json.loads(chunks[0].removeprefix("data: "))["replyType"] == "Error"
