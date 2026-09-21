import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

import database
from services import speech_db_service
from services.publishers import dog_publisher, drone_publisher, standard_robot_publisher


class FakeRobotTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item):
        self.items[Item["id"]] = Item

    def get_item(self, Key):
        item = self.items.get(Key["id"])
        return {"Item": item} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues):
        item = self.items[Key["id"]]
        for key, value in ExpressionAttributeValues.items():
            item[key.removeprefix(":")] = value

    def delete_item(self, Key):
        self.items.pop(Key["id"], None)

    def scan(self):
        return {"Items": list(self.items.values())}


def test_database_crud(monkeypatch):
    table = FakeRobotTable()
    monkeypatch.setattr(database, "robot_table", table)

    assert database.create_robot("r2", {"robot_name": "Two"})["id"] == "r2"
    database.upsert_robot("r1", {"robot_name": "One"})
    assert database.get_robot("r1")["robot_name"] == "One"
    assert database.update_robot("r1", {"ip": "127.0.0.1"})["ip"] == "127.0.0.1"
    assert [item["id"] for item in database.list_robots()] == ["r1", "r2"]
    assert database.delete_robot("r1") is True
    assert database.get_robot("r1") is None


class FakeSpeechTable:
    def __init__(self, items):
        self.items = items
        self.deleted = []

    def scan(self, **kwargs):
        return {"Items": list(self.items)}

    def delete_item(self, Key):
        self.deleted.append(Key)

    @contextmanager
    def batch_writer(self):
        yield self


def _configure_speech(monkeypatch, items):
    table = FakeSpeechTable(items)
    monkeypatch.setattr(speech_db_service, "SPEECH_TABLE", "speech")
    monkeypatch.setattr(
        speech_db_service, "dynamodb", SimpleNamespace(Table=lambda _name: table)
    )
    return table


def test_pending_speech_returns_newest_unexpired(monkeypatch):
    monkeypatch.setattr("time.time", lambda: 1000)
    _configure_speech(
        monkeypatch,
        [
            {"id": "old", "timestamp": "600000"},
            {"id": "new", "timestamp": "999000"},
            {"id": "bad", "timestamp": "invalid"},
        ],
    )
    assert speech_db_service.get_pending_speech_message()["id"] == "new"


def test_pending_speech_handles_unconfigured_and_expired(monkeypatch):
    monkeypatch.setattr(speech_db_service, "SPEECH_TABLE", "")
    assert speech_db_service.get_pending_speech_message() is None
    monkeypatch.setattr("time.time", lambda: 1000)
    _configure_speech(monkeypatch, [{"id": "old", "timestamp": 1}])
    assert speech_db_service.get_pending_speech_message() is None


def test_speech_list_delete_and_clear(monkeypatch):
    table = _configure_speech(
        monkeypatch,
        [{"id": "one", "timestamp": "2.5"}, {"id": "two", "timestamp": None}],
    )
    assert [item["id"] for item in speech_db_service.get_all_speech_messages()] == ["one", "two"]
    speech_db_service.delete_speech_message("one")
    assert table.deleted[-1] == {"id": "one"}
    assert speech_db_service.delete_all_speech_messages() == 2
    assert table.deleted[-2:] == [{"id": "one"}, {"id": "two"}]


def test_standard_robot_publisher_formats_iot_payload(monkeypatch):
    calls = []
    monkeypatch.setattr(
        standard_robot_publisher.iot_client,
        "publish",
        lambda **kwargs: calls.append(kwargs),
    )
    publisher = standard_robot_publisher.StandardRobotPublisher()
    assert publisher.publish("Robot_1", "robotMoveForward") is True
    assert calls[0]["topic"] == "Robot_1/topic"
    assert json.loads(calls[0]["payload"]) == {"toolName": "move_forward"}
    assert publisher.publish("Robot_1", "droneTakeoff") is True
    assert len(calls) == 1


def test_standard_robot_publisher_reports_failure(monkeypatch):
    monkeypatch.setattr(
        standard_robot_publisher.iot_client,
        "publish",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("iot down")),
    )
    assert standard_robot_publisher.StandardRobotPublisher().publish("r1", "wave") is False


def test_drone_publisher_maps_movement_and_rotation(monkeypatch):
    calls = []
    monkeypatch.setattr(drone_publisher.iot_client, "publish", lambda **kwargs: calls.append(kwargs))
    publisher = drone_publisher.DronePublisher()
    assert publisher.publish("DRONE_2", "droneMoveForward") is True
    assert json.loads(calls[0]["payload"]) == {
        "droneID": "drone_2",
        "action": "forward",
        "parameters": {"distance": 50},
    }
    assert publisher._map_action_to_sdk("rotate_clockwise")["params"]["angle"] == 90


def test_dog_publisher_formats_action_and_parameters(monkeypatch):
    calls = []
    monkeypatch.setattr(dog_publisher.iot_client, "publish", lambda **kwargs: calls.append(kwargs))
    publisher = dog_publisher.DogPublisher()
    assert publisher.publish("DOG_1", "dogMoveForward", {"speed": 2}) is True
    assert json.loads(calls[0]["payload"]) == {
        "dogID": "dog_1",
        "action": "move_forward",
        "parameters": {"speed": 2},
    }


@pytest.mark.parametrize(
    "module,publisher",
    [
        (drone_publisher, drone_publisher.DronePublisher()),
        (dog_publisher, dog_publisher.DogPublisher()),
    ],
)
def test_publishers_handle_iot_errors(monkeypatch, module, publisher):
    monkeypatch.setattr(
        module.iot_client,
        "publish",
        lambda **kwargs: (_ for _ in ()).throw(ConnectionError("down")),
    )
    assert publisher.publish("device_1", "moveForward") is False
