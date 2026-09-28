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
