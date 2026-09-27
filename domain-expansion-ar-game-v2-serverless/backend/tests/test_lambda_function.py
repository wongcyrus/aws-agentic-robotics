import io
import json
from decimal import Decimal
from types import SimpleNamespace

from PIL import Image

import lambda_function


def _json_body(response):
    return json.loads(response["body"])


def test_normalize_json_value_recurses():
    value = {"whole": Decimal("2"), "fraction": Decimal("1.5"), "items": [Decimal("3")]}
    assert lambda_function.normalize_json_value(value) == {
        "whole": 2,
        "fraction": 1.5,
        "items": [3],
    }


def test_optimize_commentary_image_downscales_and_converts():
    source = io.BytesIO()
    Image.new("RGBA", (1200, 600), (255, 0, 0, 128)).save(source, format="PNG")
    result = lambda_function.optimize_commentary_image(source.getvalue(), max_dimension=300)
    with Image.open(io.BytesIO(result)) as image:
        assert image.mode == "RGB"
        assert image.size == (300, 150)


def test_optimize_commentary_image_keeps_invalid_input():
    assert lambda_function.optimize_commentary_image(b"not-an-image") == b"not-an-image"


def test_http_health_and_options():
    assert lambda_function.handle_http({"path": "/health"})["statusCode"] == 200
    assert lambda_function.handle_http({"path": "/anything", "httpMethod": "OPTIONS"})["body"] == ""


def test_check_enhancement_complete_normalizes_decimal(monkeypatch):
    monkeypatch.setattr(
        lambda_function,
        "sessions_table",
        SimpleNamespace(
            get_item=lambda **kwargs: {
                "Item": {"enhanced_image_url": "https://image", "updated_at": Decimal("5")}
            }
        ),
    )
    response = lambda_function.handle_http(
        {
            "path": "/api/check-enhancement",
            "httpMethod": "GET",
            "queryStringParameters": {"sessionId": " session "},
        }
    )
    body = _json_body(response)
    assert body["status"] == "COMPLETE"
    assert body["url"] == "https://image"
    assert body["debug"]["updatedAt"] == 5


def test_enhance_portrait_records_disabled_state(monkeypatch):
    calls = []
    monkeypatch.setattr(
        lambda_function,
        "sessions_table",
        SimpleNamespace(update_item=lambda **kwargs: calls.append(kwargs)),
    )
    response = lambda_function.handle_http(
        {
            "path": "/api/enhance-portrait",
            "httpMethod": "POST",
            "body": json.dumps({"sessionId": " ", "templateId": "random"}),
        }
    )
    assert response["statusCode"] == 200
    assert calls[0]["Key"] == {"session_id": "mcpserver"}
    assert _json_body(response)["status"] == "ERROR: AWS_IMAGE_GENERATION_DISABLED"

