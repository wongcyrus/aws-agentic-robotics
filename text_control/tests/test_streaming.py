import json

import pytest

from utils.streaming import (
    CitationFilter,
    MarkdownFilter,
    ThinkingTagFilter,
    create_sync_stream_wrapper,
    stream_agent_response,
)


def _payload(sse_chunk):
    return json.loads(sse_chunk.removeprefix("data: ").strip())


def test_thinking_filter_handles_tags_split_across_chunks():
    filter_obj = ThinkingTagFilter()
    output = [
        filter_obj.process("Visible<think"),
        filter_obj.process("ing>secret"),
        filter_obj.process("</thinking> answer"),
        filter_obj.flush(),
    ]
    assert "".join(output) == "Visible answer"


def test_thinking_filter_drops_unclosed_thought():
    filter_obj = ThinkingTagFilter()
    assert filter_obj.process("answer<thinking>hidden") == "answer"
    assert filter_obj.flush() == ""


def test_citation_filter_removes_citations_and_reference_section():
    filter_obj = CitationFilter()
    assert filter_obj.process("Fact[a1] and more") == "Fact and more"
    assert filter_obj.process("**引用") == ""
    assert filter_obj.process("来源** never emitted") == ""
    assert filter_obj.flush() == ""


def test_markdown_filter_removes_tts_unfriendly_markup():
    assert MarkdownFilter().process("### **Title**\n- *item*") == "Title\nitem"


class FakeAgent:
    def __init__(self, events=None, error=None):
        self.events = events or []
        self.error = error

    async def stream_async(self, _ask_text):
        for event in self.events:
            yield event
        if self.error:
            raise self.error


@pytest.mark.asyncio
async def test_stream_agent_response_filters_and_marks_final():
    agent = FakeAgent(
        [
            {"event": "duplicate"},
            {"data": "Hello **world**[1]"},
            {"data": "<thinking>hidden</thinking>!"},
        ]
    )
    chunks = [
        _payload(chunk)
        async for chunk in stream_agent_response(agent, "ask", "session", "trace", {})
    ]

    assert [chunk["replyText"] for chunk in chunks] == ["Hello world", "!", ""]
    assert [chunk["isFinal"] for chunk in chunks] == [False, False, True]
    assert [chunk["id"] for chunk in chunks] == ["trace_1", "trace_2", "trace_3"]


@pytest.mark.asyncio
async def test_stream_agent_response_yields_error_then_reraises():
    emitted = []
    with pytest.raises(RuntimeError, match="model failed"):
        async for chunk in stream_agent_response(
            FakeAgent(error=RuntimeError("model failed")), "ask", "session", "trace", {}
        ):
            emitted.append(_payload(chunk))

    assert emitted[0]["replyType"] == "Error"
    assert emitted[0]["isFinal"] is True
    assert emitted[0]["replyText"] == "Error: model failed"


def test_sync_wrapper_consumes_async_generator():
    async def values():
        yield "one"
        yield "two"

    assert list(create_sync_stream_wrapper(values())) == ["one", "two"]
