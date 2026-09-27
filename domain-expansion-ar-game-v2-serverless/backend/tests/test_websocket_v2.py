import json
import logging
import random

from observability import MetricsEmitter
from websocket_handler import handle_websocket_event


class ConnectionsTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item, **kwargs):
        self.items[Item["connection_id"]] = Item

    def get_item(self, Key):
        item = self.items.get(Key["connection_id"])
        return {"Item": item} if item else {}

    def delete_item(self, Key):
        self.items.pop(Key["connection_id"], None)

    def query(self, **kwargs):
        room_id = kwargs["KeyConditionExpression"]._values[1]
        return {
            "Items": [
                item for item in self.items.values() if item["room_code"] == room_id
            ]
        }


class SessionsTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["session_id"])
        return {"Item": item} if item else {}

    def put_item(self, Item, **kwargs):
        expected = kwargs.get("ExpressionAttributeValues", {}).get(":expected")
        existing = self.items.get(Item["session_id"])
        if existing is not None and existing["revision"] != expected:
            raise AssertionError("unexpected revision")
        self.items[Item["session_id"]] = Item


class ApiClient:
    def __init__(self):
        self.posts = []

    def post_to_connection(self, **kwargs):
        self.posts.append(kwargs)


def invoke(
    body,
    connection_id,
    connections,
    sessions,
    api,
    *,
    now=100.0,
):
    return handle_websocket_event(
        {"body": json.dumps(body)},
        {
            "connectionId": connection_id,
            "routeKey": "$default",
        },
        connections_table=connections,
        sessions_table=sessions,
        api_client=api,
        logger=logging.getLogger("test"),
        metrics=MetricsEmitter(),
        clock=lambda: now,
        rng=random.Random(7),
    )


def join(role, connection_id, connections, sessions, api):
    response = invoke(
        {
            "action": "join",
            "roomId": "ROOM",
            "role": role,
            "clientId": f"{role}-client",
        },
        connection_id,
        connections,
        sessions,
        api,
    )
    assert response["statusCode"] == 200


def command(
    message_type,
    payload,
    role_connection,
    connections,
    sessions,
    api,
    *,
    message_id,
    match_id=None,
    now=100.0,
):
    return invoke(
        {
            "action": "command",
            "envelope": {
                "protocolVersion": "2.0",
                "messageId": message_id,
                "messageType": message_type,
                "roomId": "ROOM",
                "matchId": match_id,
                "payload": payload,
            },
        },
        role_connection,
        connections,
        sessions,
        api,
        now=now,
    )


def test_match_flow_persists_authoritative_state_and_rejects_duplicates():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer", connections, sessions, api)
    join("player1", "p1", connections, sessions, api)
    join("player2", "p2", connections, sessions, api)

    response = command(
        "match.start",
        {
            "config": {
                "difficultySeconds": 8,
                "challengeCount": 2,
                "countdownSeconds": 0,
                "scoreGraceMs": 1000,
                "synchronizedGestures": True,
            }
        },
        "viewer",
        connections,
        sessions,
        api,
        message_id="start",
    )
    assert response["statusCode"] == 200
    state = sessions.items["v2-room:ROOM"]
    match_id = state["matchId"]
    assert state["phase"] == "countdown"

    response = command(
        "match.countdownCompleted",
        {},
        "viewer",
        connections,
        sessions,
        api,
        message_id="countdown",
        match_id=match_id,
    )
    assert response["statusCode"] == 200
    state = sessions.items["v2-room:ROOM"]
    challenge = state["players"]["player1"]["challenge"]
    assert state["phase"] == "playing"

    response = command(
        "challenge.succeeded",
        {
            "challengeId": challenge["challengeId"],
            "technique": challenge["technique"],
            "videoSrc": "/static/video/test.mp4",
        },
        "p1",
        connections,
        sessions,
        api,
        message_id="success",
        match_id=match_id,
        now=101.0,
    )
    assert response["statusCode"] == 200
    state = sessions.items["v2-room:ROOM"]
    assert state["phase"] == "resolving"
    assert state["players"]["player1"]["score"] == 1

    response = command(
        "challenge.succeeded",
        {},
        "p1",
        connections,
        sessions,
        api,
        message_id="success",
        match_id=match_id,
        now=101.2,
    )
    assert response["statusCode"] == 200
    assert sessions.items["v2-room:ROOM"]["players"]["player1"]["score"] == 1


def test_reconnect_does_not_reset_match():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer-one", connections, sessions, api)
    command(
        "match.start",
        {"config": {"countdownSeconds": 3}},
        "viewer-one",
        connections,
        sessions,
        api,
        message_id="start",
    )
    match_id = sessions.items["v2-room:ROOM"]["matchId"]

    join("viewer", "viewer-two", connections, sessions, api)
    state = sessions.items["v2-room:ROOM"]
    assert state["matchId"] == match_id
    assert state["phase"] == "countdown"
