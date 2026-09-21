import io
from types import SimpleNamespace

import pytest

import commentary_tts


@pytest.mark.parametrize(
    ("language", "expected"),
    [
        ("yue-CN", "zh-HK"),
        ("zh-cn", "zh-TW"),
        ("ja-JP", "ja"),
        ("fr", "en"),
        ("", "en"),
    ],
)
def test_normalize_tts_language(language, expected):
    assert commentary_tts.normalize_tts_language(language) == expected


def test_safe_session_segment():
    assert commentary_tts._safe_session_segment(" room/user 1 ") == "room-user-1"
    assert commentary_tts._safe_session_segment("***") == "main"


def test_synthesize_retries_standard_engine(monkeypatch):
    calls = []

    def synthesize(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("neural unavailable")
        return {"AudioStream": io.BytesIO(b"audio")}

    monkeypatch.setattr(commentary_tts, "polly_client", SimpleNamespace(synthesize_speech=synthesize))
    voice = commentary_tts.get_voice_for_language("en")
    assert commentary_tts._synthesize_speech_bytes("hello", voice) == b"audio"
    assert calls[1]["Engine"] == "standard"


def test_synthesize_commentary_audio_uploads_and_returns_metadata(monkeypatch):
    put_calls = []
    monkeypatch.setattr(commentary_tts, "COMMENTARY_AUDIO_BUCKET", "bucket")
    monkeypatch.setattr(commentary_tts, "_synthesize_speech_bytes", lambda *args: b"audio")
    monkeypatch.setattr(commentary_tts, "_calculate_mp3_duration", lambda _audio: 1.25)
    monkeypatch.setattr(commentary_tts.uuid, "uuid4", lambda: "fixed")
    monkeypatch.setattr(
        commentary_tts,
        "s3_client",
        SimpleNamespace(
            put_object=lambda **kwargs: put_calls.append(kwargs),
            generate_presigned_url=lambda *args, **kwargs: "https://signed",
        ),
    )

    result = commentary_tts.synthesize_commentary_audio("**Hello**", "room/user", "en")

    assert put_calls[0]["Body"] == b"audio"
    assert put_calls[0]["Key"].endswith("room-user/fixed.mp3")
    assert result["audioUrl"] == "https://signed"
    assert result["duration"] == 1.25


def test_synthesize_commentary_audio_requires_text_and_bucket(monkeypatch):
    monkeypatch.setattr(commentary_tts, "COMMENTARY_AUDIO_BUCKET", "")
    assert commentary_tts.synthesize_commentary_audio("hello", "session", "en") is None
    monkeypatch.setattr(commentary_tts, "COMMENTARY_AUDIO_BUCKET", "bucket")
    assert commentary_tts.synthesize_commentary_audio("  ", "session", "en") is None
