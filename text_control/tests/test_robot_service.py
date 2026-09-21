from types import SimpleNamespace

import pytest

from services.robot_service import RobotService


class Publisher:
    def __init__(self, result=True):
        self.result = result
        self.calls = []
        self.action_mapping = {
            "move_forward": {"type": "movement", "action": "move_forward"},
            "rotate": {"type": "rotation", "action": "rotate"},
        }

    def publish(self, robot_id, message, parameters=None):
        self.calls.append((robot_id, message, parameters))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def service():
    async def available():
        return {"move", "stop"}

    return RobotService(
        robot_publisher=Publisher(),
        drone_publisher=Publisher(),
        dog_publisher=Publisher(),
        action_loader=available,
        sleep_fn=lambda _seconds: None,
    )


@pytest.mark.parametrize(
    ("selected", "publisher_name", "expected_count"),
    [
        ("all_robots", "robot_publisher", 6),
        ("all_drones", "drone_publisher", 2),
        ("drone_1", "drone_publisher", 1),
        ("all_dogs", "dog_publisher", 3),
        ("dog_2", "dog_publisher", 1),
        ("robot_3", "robot_publisher", 1),
        ("custom", "robot_publisher", 1),
    ],
)
def test_execute_robot_action_routes_to_expected_publisher(
    service, selected, publisher_name, expected_count
):
    assert service.execute_robot_action("move", selected, {"speed": 1}) is True
    assert len(getattr(service, publisher_name).calls) == expected_count


def test_execute_robot_action_validates_and_handles_failure(service):
    assert service.execute_robot_action("", "robot_1") is False
    service.robot_publisher.result = RuntimeError("publish failed")
    assert service.execute_robot_action("move", "robot_1") is False


def test_execute_parallel_actions_aggregates_results(service):
    service.robot_publisher.result = False
    assert service._execute_parallel_actions(["r1", "r2"], "move", service.robot_publisher) is False


def test_execute_dog_action_routes_all_and_rejects_invalid(service):
    assert service.execute_dog_action("all", "move_forward") is True
    assert len(service.dog_publisher.calls) == 3
    assert service.execute_dog_action("cat_1", "move_forward") is False


@pytest.mark.asyncio
async def test_process_actions_validates_each_action(service):
    results = await service.process_actions(["move", "unknown"], "robot_1")
    assert results == [
        {"robot": "robot_1", "action": "move", "success": True},
        {
            "robot": "robot_1",
            "action": "unknown",
            "success": False,
            "error": "Action not available",
        },
    ]


@pytest.mark.asyncio
async def test_process_actions_returns_empty_on_lookup_failure(service):
    async def unavailable():
        raise RuntimeError("MCP unavailable")

    service._action_loader = unavailable
    assert await service.process_actions(["move"], "robot_1") == []


@pytest.mark.parametrize(
    ("robot_id", "expected_type"),
    [
        ("dog_1", "dog"),
        ("drone_1", "drone"),
        ("robot_1", "standard_robot"),
        ("other", "unknown"),
    ],
)
def test_get_robot_status(service, robot_id, expected_type):
    assert service.get_robot_status(robot_id)["type"] == expected_type


@pytest.mark.parametrize(
    ("action", "parameters", "valid"),
    [
        ("missing", {}, False),
        ("move_forward", {"distance": 10, "speed": 0.5}, True),
        ("move_forward", {"distance": 0, "speed": 2}, False),
        ("move_forward", {"distance": "bad", "speed": "bad"}, False),
        ("rotate", {"angle": 180}, True),
        ("rotate", {"angle": 500}, False),
    ],
)
def test_validate_dog_action(service, action, parameters, valid):
    assert service.validate_dog_action(action, parameters)["valid"] is valid


def test_capture_image_requires_bucket(service, monkeypatch):
    monkeypatch.delenv("MEDIA_BUCKET_NAME", raising=False)
    assert service.capture_image("robot_1") == {
        "success": False,
        "error": "Image bucket not configured",
    }


def test_capture_image_publishes_and_returns_read_url(service, monkeypatch):
    class ClientError(Exception):
        pass

    class S3:
        exceptions = SimpleNamespace(ClientError=ClientError)

        def __init__(self):
            self.head_calls = 0

        def generate_presigned_url(self, operation, **kwargs):
            return f"https://signed/{operation}"

        def head_object(self, **kwargs):
            self.head_calls += 1
            if self.head_calls == 1:
                raise ClientError()

    s3, publishes = S3(), []
    monkeypatch.setenv("MEDIA_BUCKET_NAME", "bucket")
    service._uuid_factory = lambda: "fixed"
    service._client_factory = (
        lambda name, **kwargs: s3
        if name == "s3"
        else SimpleNamespace(publish=lambda **call: publishes.append(call))
    )
    assert service.capture_image("robot_1") == {
        "success": True,
        "image_url": "https://signed/get_object",
    }
    assert publishes[0]["topic"] == "robot_1/topic"


def test_capture_image_returns_iot_failure(service, monkeypatch):
    s3 = SimpleNamespace(
        generate_presigned_url=lambda *args, **kwargs: "https://upload",
    )
    monkeypatch.setenv("MEDIA_BUCKET_NAME", "bucket")
    service._client_factory = (
        lambda name, **kwargs: s3
        if name == "s3"
        else SimpleNamespace(
            publish=lambda **call: (_ for _ in ()).throw(RuntimeError("down"))
        )
    )
    assert service.capture_image("robot_1")["error"] == "IoT publish failed: down"
