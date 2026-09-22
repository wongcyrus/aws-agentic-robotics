"""Pure orchestration helpers shared by the text-control chat routes."""

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Iterator, Mapping, Protocol


class AgentFactory(Protocol):
    def __call__(
        self,
        session_id: str,
        background: str,
        **kwargs: bool,
    ) -> Awaitable[Any]: ...


class ResponseStreamer(Protocol):
    def __call__(
        self,
        agent: Any,
        ask_text: str,
        session_id: str,
        trace_id: str,
        extra: Dict[str, Any],
    ) -> AsyncIterator[str]: ...


class SyncWrapper(Protocol):
    def __call__(self, stream: AsyncIterator[str]) -> Iterator[str]: ...


@dataclass(frozen=True)
class StreamRequest:
    ask_text: str
    session_id: str
    trace_id: str
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> "StreamRequest":
        return cls(
            ask_text=str(params["ask_text"]),
            session_id=str(params["session_id"]),
            trace_id=str(params["trace_id"]),
            extra=dict(params.get("extra") or {}),
        )


@dataclass(frozen=True)
class RobotPromptContext:
    name: str = "Robot"
    background: str = ""

    @classmethod
    def from_record(cls, record: Mapping[str, Any] | None):
        if not record:
            return cls()
        return cls(
            name=record.get("robot_name") or "Robot",
            background=record.get("context") or "",
        )

    def as_prompt_block(self) -> str:
        if not self.background and self.name == "Robot":
            return ""
        return (
            f"\n<background>Your Name:{self.name}\nbackground: {self.background}\n</background>\n"
        )


def build_stream_error(
    request: StreamRequest,
    error: Exception,
    *,
    include_generated_id: bool = False,
    now: Callable[[], datetime] = datetime.now,
    id_factory: Callable[[], Any] = uuid.uuid4,
) -> str:
    payload = {
        "askText": request.ask_text,
        "extra": request.extra,
        "traceId": request.trace_id,
        "replyPayload": None,
        "replyText": f"Error: {error}",
        "replyType": "Error",
        "sessionId": request.session_id,
        "timestamp": int(now().timestamp() * 1000),
        "isFinal": True,
    }
    payload["id"] = str(id_factory()) if include_generated_id else request.trace_id
    return f"data: {json.dumps(payload)}\n\n"


def create_agent_stream(
    request: StreamRequest,
    background: str,
    *,
    agent_factory: AgentFactory,
    response_streamer: ResponseStreamer,
    sync_wrapper: SyncWrapper,
    enable_grounding: bool = False,
    include_generated_error_id: bool = False,
    on_error: Callable[[Exception], None] | None = None,
) -> Iterator[str]:
    async def async_stream():
        agent = await agent_factory(
            request.session_id,
            background,
            **({"enable_grounding": True} if enable_grounding else {}),
        )
        async for chunk in response_streamer(
            agent,
            request.ask_text,
            request.session_id,
            request.trace_id,
            request.extra,
        ):
            yield chunk

    try:
        yield from sync_wrapper(async_stream())
    except Exception as error:
        if on_error:
            on_error(error)
        yield build_stream_error(
            request,
            error,
            include_generated_id=include_generated_error_id,
        )
