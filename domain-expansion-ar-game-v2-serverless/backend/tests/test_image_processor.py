import io
from types import SimpleNamespace

from PIL import Image

import image_processor


def _image_bytes(size=(100, 80)):
    output = io.BytesIO()
    Image.new("RGB", size, "blue").save(output, format="JPEG")
    return output.getvalue()


def test_get_cropped_face_applies_padding(monkeypatch):
    rekognition = SimpleNamespace(
        detect_faces=lambda **kwargs: {
            "FaceDetails": [
                {"BoundingBox": {"Left": 0.2, "Top": 0.25, "Width": 0.4, "Height": 0.5}}
            ]
        }
    )
    monkeypatch.setattr(image_processor.boto3, "client", lambda name, **kwargs: rekognition)
    face = image_processor.get_cropped_face(_image_bytes())
    assert face.size == (60, 60)


def test_get_cropped_face_returns_none_without_detection(monkeypatch):
    monkeypatch.setattr(
        image_processor.boto3,
        "client",
        lambda name, **kwargs: SimpleNamespace(
            detect_faces=lambda **kwargs: {"FaceDetails": []}
        ),
    )
    assert image_processor.get_cropped_face(_image_bytes()) is None


def test_image_worker_marks_missing_snapshots(monkeypatch):
    updates = []
    monkeypatch.setattr(
        image_processor,
        "sessions_table",
        SimpleNamespace(
            get_item=lambda **kwargs: {"Item": {"session_id": "session"}},
            update_item=lambda **kwargs: updates.append(kwargs),
        ),
    )
    monkeypatch.setattr(image_processor, "PHOTOS_S3_BUCKET", None)

    image_processor.handle_sqs_image_gen(
        {"messageId": "1", "body": '{"session_id":"session","template_id":"infinite_clash"}'}
    )

    assert updates[0]["ExpressionAttributeValues"][":value"] == "ERROR: SNAPSHOTS_MISSING"
