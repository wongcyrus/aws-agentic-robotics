import base64
import io
import json
from types import SimpleNamespace

from PIL import Image

import image_processor


class Body:
    def __init__(self, value):
        self.value = value

    def read(self):
        return self.value


class Table:
    def __init__(self, item):
        self.item = item
        self.updates = []

    def get_item(self, **kwargs):
        return {"Item": self.item}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)


def test_image_generation_happy_path_uses_s3_bedrock_and_updates_session(monkeypatch):
    table = Table({"session_id": "session"})
    image = io.BytesIO()
    Image.new("RGB", (200, 200), "blue").save(image, format="JPEG")
    source_bytes = image.getvalue()
    s3_puts = []

    class S3:
        def get_object(self, **kwargs):
            return {"Body": Body(source_bytes)}

        def put_object(self, **kwargs):
            s3_puts.append(kwargs)

    generated = base64.b64encode(b"generated-image").decode()
    bedrock = SimpleNamespace(
        invoke_model=lambda **kwargs: {
            "body": Body(json.dumps({"images": [generated]}).encode())
        }
    )
    monkeypatch.setattr(image_processor, "sessions_table", table)
    monkeypatch.setattr(image_processor, "PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setenv("PHOTOS_S3_DOMAIN", "cdn.example")
    monkeypatch.setattr(
        image_processor.boto3,
        "client",
        lambda name, **kwargs: bedrock if name == "bedrock-runtime" else S3(),
    )
    monkeypatch.setattr(
        image_processor,
        "get_cropped_face",
        lambda _bytes: Image.new("RGB", (100, 100), "red"),
    )

    image_processor.handle_sqs_image_gen(
        {
            "messageId": "one",
            "body": json.dumps({"session_id": "session", "template_id": "infinite_clash"}),
        }
    )

    assert s3_puts[0]["Body"] == b"generated-image"
    assert table.updates[-1]["ExpressionAttributeValues"][":url"].startswith(
        "https://cdn.example/enhanced_portraits/session/"
    )


def test_image_generation_marks_no_face(monkeypatch):
    encoded = base64.b64encode(b"snapshot").decode()
    table = Table(
        {
            "session_id": "session",
            "latest_webcam_frame_p1": encoded,
            "latest_webcam_frame_p2": encoded,
        }
    )
    monkeypatch.setattr(image_processor, "sessions_table", table)
    monkeypatch.setattr(image_processor, "PHOTOS_S3_BUCKET", None)
    monkeypatch.setattr(image_processor, "get_cropped_face", lambda _bytes: None)
    image_processor.handle_sqs_image_gen(
        {"messageId": "one", "body": '{"session_id":"session","template_id":"sendai_clash"}'}
    )
    assert table.updates[-1]["ExpressionAttributeValues"][":value"] == "ERROR: NO_FACE"


def test_image_generation_maps_bedrock_access_error(monkeypatch):
    table = Table({"session_id": "session"})
    image = Image.new("RGB", (20, 20), "red")
    monkeypatch.setattr(image_processor, "sessions_table", table)
    monkeypatch.setattr(image_processor, "PHOTOS_S3_BUCKET", None)
    monkeypatch.setattr(
        image_processor,
        "get_cropped_face",
        lambda _bytes: Image.new("RGB", (20, 20), "red"),
    )
    encoded = base64.b64encode(b"snapshot").decode()
    table.item.update(
        {
            "latest_webcam_frame_p1": encoded,
            "latest_webcam_frame_p2": encoded,
        }
    )
    monkeypatch.setattr(
        image_processor.boto3,
        "client",
        lambda name, **kwargs: SimpleNamespace(
            invoke_model=lambda **call: (_ for _ in ()).throw(
                RuntimeError("AccessDeniedException")
            )
        ),
    )
    image_processor.handle_sqs_image_gen(
        {"messageId": "one", "body": '{"session_id":"session","template_id":"sendai_clash"}'}
    )
    assert table.updates[-1]["ExpressionAttributeValues"][":value"] == "ERROR: BEDROCK_ACCESS_DENIED"


def test_image_generation_handles_invalid_message_and_database_failure(monkeypatch):
    table = SimpleNamespace(
        get_item=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("db down"))
    )
    monkeypatch.setattr(image_processor, "sessions_table", table)
    image_processor.handle_sqs_image_gen({"messageId": "one", "body": "not-json"})
    image_processor.handle_sqs_image_gen(
        {"messageId": "two", "body": '{"session_id":"session"}'}
    )


def test_image_generation_marks_composite_and_upload_failures(monkeypatch):
    encoded = base64.b64encode(b"snapshot").decode()
    table = Table(
        {
            "session_id": "session",
            "latest_webcam_frame_p1": encoded,
            "latest_webcam_frame_p2": encoded,
        }
    )
    monkeypatch.setattr(image_processor, "sessions_table", table)
    monkeypatch.setattr(image_processor, "PHOTOS_S3_BUCKET", None)
    monkeypatch.setattr(
        image_processor,
        "get_cropped_face",
        lambda _bytes: Image.new("RGB", (20, 20), "red"),
    )
    monkeypatch.setattr(
        image_processor.Image,
        "open",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("bad template")),
    )
    image_processor.handle_sqs_image_gen(
        {"messageId": "one", "body": '{"session_id":"session","template_id":"sendai_clash"}'}
    )
    assert table.updates[-1]["ExpressionAttributeValues"][":value"] == "ERROR: COMPOSITE_FAILED"
