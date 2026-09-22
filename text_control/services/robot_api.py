"""Typed request parsing and response extraction for robot API routes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class ActionRequest:
    robot_id: str
    method: str
    action: str

    @classmethod
    def from_payload(cls, robot_id: str, payload: Mapping[str, Any] | None) -> "ActionRequest":
        data = payload or {}
        return cls(
            robot_id=robot_id or str(data.get("robot") or ""),
            method=str(data.get("method") or ""),
            action=str(data.get("action") or ""),
        )

    @property
    def execution_actions(self) -> list[str] | None:
        if self.method == "RunAction" and self.action:
            return [self.action]
        if self.method == "StopAction":
            return ["stop"]
        return None


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    language: str = "yue"

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any] | None) -> "SpeechRequest":
        data = payload or {}
        return cls(
            text=str(data.get("text") or "").strip(),
            language=str(data.get("language") or "yue"),
        )


def extract_mcp_text(result: Any) -> str:
    content = result.get("content", []) if isinstance(result, dict) else []
    return next(
        (
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ),
        str(result),
    )
