import hashlib
import json

import pytest
from flask import Flask

from utils import auth, response_utils


@pytest.fixture
def app():
    return Flask(__name__)


@pytest.mark.parametrize("ask_text", ["", "   ", "\t\t", "\n\n", "  \t\n  "])
def test_parse_request_rejects_empty_ask_text(app, ask_text):
    with app.test_request_context("/", json={"askText": ask_text}):
        params, error = response_utils.parse_request_params(["askText"])

    assert params is None
    assert error.status_code == 400
    assert error.get_json()["error"]["message"] == "Parameter 'askText' cannot be empty or blank"


def test_parse_request_extracts_defaults_and_values(app):
    payload = {
        "askText": "move forward",
        "sessionId": "session-1",
        "traceId": "trace-1",
        "extra": {"source": "test"},
        "languageCode": "en",
    }
    with app.test_request_context("/", json=payload):
        params, error = response_utils.parse_request_params(["askText"])

    assert error is None
    assert params == {
        "ask_text": "move forward",
        "session_id": "session-1",
        "trace_id": "trace-1",
        "extra": {"source": "test"},
        "language_code": "en",
        "device_id": "",
        "user_params": "",
        "lang_by_asr": "",
    }


def test_legacy_signature_matches_vendor_algorithm():
    body, secret, timestamp = '{"askText":"hello"}', "secret", "123"
    expected = hashlib.sha512(f"{body}{secret}{timestamp}".encode()).hexdigest()
    assert auth.calculate_signature(secret, timestamp, body) == expected


def test_v2_signature_sorts_fields_and_uppercases():
    body, secret, timestamp = '{"askText":"hello"}', "secret", "123"
    source = f"bodyString={body}&secretKey={secret}&timestamp={timestamp}"
    expected = hashlib.sha512(source.encode()).hexdigest().upper()
    assert auth.calculate_signature_v2(secret, timestamp, body) == expected


def test_validate_authentication_accepts_valid_environment_credentials(app, monkeypatch):
    body = json.dumps({"askText": "hello"}, separators=(",", ":"))
    timestamp = "123"
    signature = auth.calculate_signature_v2("secret", timestamp, body)
    monkeypatch.setenv(
        "XIAOICE_PROJECT_CREDENTIALS",
        json.dumps({"access": {"secret_key": "secret", "project_id": "project-1"}}),
    )
    monkeypatch.setattr(auth, "get_secret", lambda _name: None)

    with app.test_request_context(
        "/api/talk",
        data=body,
        content_type="application/json",
        headers={"X-Timestamp": timestamp, "X-Sign": signature, "X-Key": "access"},
    ):
        project_id, error = auth.validate_authentication()

    assert error is None
    assert project_id == "project-1"


def test_validate_authentication_rejects_bad_signature(app, monkeypatch):
    monkeypatch.setenv(
        "XIAOICE_PROJECT_CREDENTIALS",
        json.dumps({"access": {"secret_key": "secret", "project_id": "project-1"}}),
    )
    monkeypatch.setattr(auth, "get_secret", lambda _name: None)

    with app.test_request_context(
        "/api/talk",
        data="{}",
        headers={"X-Timestamp": "123", "X-Sign": "wrong", "X-Key": "access"},
    ):
        project_id, error = auth.validate_authentication()

    assert project_id is None
    assert error.status_code == 401
    assert error.get_json()["error"]["message"] == "Invalid signature"
