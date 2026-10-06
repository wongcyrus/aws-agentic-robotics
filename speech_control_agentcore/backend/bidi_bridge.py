"""Translate between browser WebSocket payloads and Strands Bidi events."""

import base64
from dataclasses import dataclass
from typing import Any

from strands.bidi.types import AudioDelta


def convert_client_event(event_type: str, event_data: dict[str, Any]):
    """Convert a browser input payload to a GA Strands Bidi input."""
    if event_type == "bidi_audio_input":
        encoded_audio = event_data.get("audio")
        if not isinstance(encoded_audio, str):
            raise ValueError("Audio input must contain base64-encoded audio.")
        try:
            audio_bytes = base64.b64decode(encoded_audio, validate=True)
        except ValueError as error:
            raise ValueError("Audio input is not valid base64.") from error
        return AudioDelta(
            format=event_data.get("format", "pcm"),
            source={"bytes": audio_bytes},
        )

    if event_type == "bidi_text_input":
        text = event_data.get("text", event_data.get("data"))
        if not isinstance(text, str) or not text:
            raise ValueError("Text input must contain non-empty text.")
        return text

    if event_type == "bidi_image_input":
        image = event_data.get("image", event_data.get("data"))
        if not isinstance(image, dict):
            raise ValueError("Image input must contain an image object.")
        return {"image": image}

    raise ValueError(f"Unsupported Bidi input event type: {event_type}")


@dataclass
class BidiBrowserBridge:
    """Translate GA Strands output events into the existing browser protocol."""

    response_interrupted: bool = False

    def translate_output_event(self, event) -> tuple[bool, dict | None]:
        event_type = type(event).__name__

        if event_type in ["BidiTranscriptDeltaEvent", "BidiTextDeltaEvent"]:
            return True, {
                "event": {
                    "textOutput": {
                        "content": getattr(event, "delta", ""),
                        "role": getattr(event, "role", "assistant").upper(),
                    }
                }
            }

        if event_type == "BidiAudioDeltaEvent":
            return True, {
                "event": {
                    "audioOutput": {
                        "content": getattr(event, "audio", ""),
                    }
                }
            }

        if event_type == "BidiResponseStartEvent":
            self.response_interrupted = False
            return True, {
                "event": {
                    "contentStart": {
                        "type": "TEXT",
                        "role": "ASSISTANT",
                    }
                }
            }

        if event_type == "BidiBargeInEvent":
            self.response_interrupted = True
            return True, {
                "event": {
                    "contentEnd": {
                        "type": "TEXT",
                        "stopReason": "INTERRUPTED",
                    }
                }
            }

        if event_type == "BidiResponseStopEvent":
            if self.response_interrupted:
                self.response_interrupted = False
                return True, None
            return True, {
                "event": {
                    "contentEnd": {
                        "type": "TEXT",
                        "stopReason": "END_TURN",
                    }
                }
            }

        return False, None
