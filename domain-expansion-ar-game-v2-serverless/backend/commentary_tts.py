import io
import logging
import os
import re
import uuid
import markdown
from bs4 import BeautifulSoup

import boto3
from botocore.config import Config
try:
    from mutagen.mp3 import MP3
except Exception:  # pragma: no cover - optional runtime dependency fallback
    MP3 = None

logger = logging.getLogger()

COMMENTARY_AUDIO_BUCKET = os.environ.get("PHOTOS_S3_BUCKET", "")
COMMENTARY_AUDIO_PREFIX = os.environ.get("COMMENTARY_AUDIO_PREFIX", "commentary-audio")
COMMENTARY_AUDIO_URL_EXPIRY = int(os.environ.get("COMMENTARY_AUDIO_URL_EXPIRY", "600"))

polly_client = boto3.client(
    "polly",
    config=Config(retries={"max_attempts": 3, "mode": "standard"}),
)
s3_client = boto3.client(
    "s3",
    config=Config(retries={"max_attempts": 3, "mode": "standard"}),
)

VOICE_MAP = {
    "zh-HK": {"voice_id": "Hiujin", "engine": "neural", "language_code": "yue-CN"},
    "zh-TW": {"voice_id": "Zhiyu", "engine": "neural", "language_code": "cmn-CN"},
    "en": {"voice_id": "Joanna", "engine": "neural", "language_code": "en-US"},
    "ja": {"voice_id": "Mizuki", "engine": "standard", "language_code": "ja-JP"},
}


def normalize_tts_language(language: str) -> str:
    if not language:
        return "en"

    normalized = language.strip().lower()
    if normalized in {"zh-hk", "yue", "yue-cn"}:
        return "zh-HK"
    if normalized in {"zh-tw", "zh-hant", "zh", "zh-cn", "cmn", "cmn-cn"}:
        return "zh-TW"
    if normalized.startswith("ja"):
        return "ja"
    return "en"


def get_voice_for_language(language: str) -> dict:
    return VOICE_MAP.get(normalize_tts_language(language), VOICE_MAP["en"])


def _safe_session_segment(session_id: str) -> str:
    safe_value = re.sub(r"[^A-Za-z0-9._-]+", "-", (session_id or "main").strip())
    return safe_value.strip("-") or "main"


def _synthesize_speech_bytes(text: str, voice_config: dict) -> bytes | None:
    try:
        response = polly_client.synthesize_speech(
            Text=text,
            OutputFormat="mp3",
            VoiceId=voice_config["voice_id"],
            Engine=voice_config["engine"],
            LanguageCode=voice_config["language_code"],
        )
    except Exception as exc:
        if voice_config["engine"] != "standard":
            logger.warning(
                "Polly neural synthesis failed for %s, retrying standard engine: %s",
                voice_config["voice_id"],
                exc,
            )
            response = polly_client.synthesize_speech(
                Text=text,
                OutputFormat="mp3",
                VoiceId=voice_config["voice_id"],
                Engine="standard",
                LanguageCode=voice_config["language_code"],
            )
        else:
            logger.error("Polly synthesis failed for %s: %s", voice_config["voice_id"], exc)
            return None

    audio_stream = response.get("AudioStream")
    if not audio_stream:
        logger.error("Polly returned no AudioStream for %s", voice_config["voice_id"])
        return None
    return audio_stream.read()


def _calculate_mp3_duration(audio_bytes: bytes) -> float:
    if MP3 is None:
        logger.warning("mutagen is unavailable; returning commentary audio duration as 0")
        return 0.0
    try:
        return float(MP3(io.BytesIO(audio_bytes)).info.length)
    except Exception as exc:
        logger.warning("Failed to calculate commentary audio duration: %s", exc)
        return 0.0


def synthesize_commentary_audio(text: str, session_id: str, language: str) -> dict | None:
    normalized_text = (text or "").strip()
    if not normalized_text or not COMMENTARY_AUDIO_BUCKET:
        return None

    try:
        html = markdown.markdown(normalized_text)
        plain_text = BeautifulSoup(html, "html.parser").get_text()
    except Exception as e:
        logger.error(f"Failed to strip markdown: {e}")
        plain_text = normalized_text

    voice_config = get_voice_for_language(language)
    audio_bytes = _synthesize_speech_bytes(plain_text, voice_config)
    if not audio_bytes:
        return None
    duration = _calculate_mp3_duration(audio_bytes)

    object_key = (
        f"{COMMENTARY_AUDIO_PREFIX.strip('/')}/"
        f"{_safe_session_segment(session_id)}/{uuid.uuid4()}.mp3"
    )

    try:
        s3_client.put_object(
            Bucket=COMMENTARY_AUDIO_BUCKET,
            Key=object_key,
            Body=audio_bytes,
            ContentType="audio/mpeg",
        )
        audio_url = s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": COMMENTARY_AUDIO_BUCKET, "Key": object_key},
            ExpiresIn=COMMENTARY_AUDIO_URL_EXPIRY,
        )
    except Exception as exc:
        logger.error("Failed to upload/generate commentary audio URL: %s", exc)
        return None

    return {
        "audioUrl": audio_url,
        "objectKey": object_key,
        "voiceId": voice_config["voice_id"],
        "duration": duration,
        "ttsMode": "aws",
    }
