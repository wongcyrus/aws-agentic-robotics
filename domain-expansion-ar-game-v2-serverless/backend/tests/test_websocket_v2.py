import copy
import json
import logging
import random
from decimal import Decimal

import pytest
from botocore.exceptions import ClientError
from observability import MetricsEmitter
from websocket_handler import (
    _default_state,
    _evaluate_winner,
    _normalize,
    _public_state,
    _shuffle_techniques,
    handle_websocket_event,
)


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
        return {"Items": [item for item in self.items.values() if item["room_code"] == room_id]}


class SessionsTable:
    def __init__(self):
        self.items = {}
        self.conflict_item = None
        self.failures = 0
        self.put_calls = 0

    def get_item(self, Key):
        item = self.items.get(Key["session_id"])
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, Item, **kwargs):
        self.put_calls += 1
        expected = kwargs.get("ExpressionAttributeValues", {}).get(":expected")
        existing = self.items.get(Item["session_id"])
        if self.conflict_item is not None:
            self.items[Item["session_id"]] = copy.deepcopy(self.conflict_item)
            self.conflict_item = None
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "PutItem",
            )
        if self.failures:
            self.failures -= 1
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "PutItem",
            )
        if existing is not None and existing["revision"] != expected:
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "PutItem",
            )
        self.items[Item["session_id"]] = copy.deepcopy(Item)


class ApiClient:
    def __init__(self):
        self.posts = []

    def post_to_connection(self, **kwargs):
        self.posts.append(kwargs)

    def messages(self, connection_id=None):
        posts = self.posts
        if connection_id:
            posts = [post for post in posts if post["ConnectionId"] == connection_id]
        return [json.loads(post["Data"]) for post in posts]


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


def invoke_route(
    route_key,
    connection_id,
    connections,
    sessions,
    api,
    *,
    body=None,
    now=100.0,
):
    return handle_websocket_event(
        {"body": json.dumps(body or {})},
        {
            "connectionId": connection_id,
            "routeKey": route_key,
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
                "revision": sessions.items.get("v2-room:ROOM", {}).get("revision", 0),
                "payload": payload,
            },
        },
        role_connection,
        connections,
        sessions,
        api,
        now=now,
    )


def start_playing(
    connections,
    sessions,
    api,
    *,
    challenge_count=1,
    score_grace_ms=1000,
):
    join("viewer", "viewer", connections, sessions, api)
    join("player1", "p1", connections, sessions, api)
    join("player2", "p2", connections, sessions, api)
    response = command(
        "match.start",
        {
            "config": {
                "difficultySeconds": 8,
                "challengeCount": challenge_count,
                "countdownSeconds": 0,
                "scoreGraceMs": score_grace_ms,
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
    match_id = sessions.items["v2-room:ROOM"]["matchId"]
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
    return match_id


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
                "captureSnapshots": False,
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
    assert state["config"]["captureSnapshots"] is False

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


def test_state_helpers_normalize_public_data_and_winner_bounds():
    assert _normalize(Decimal("2")) == 2
    assert _normalize(Decimal("2.5")) == 2.5
    assert _normalize({"value": [Decimal("3")]}) == {"value": [3]}

    state = _default_state("ROOM", 1000)
    assert "session_id" not in _public_state(state)
    assert "challengeLists" not in _public_state(state)
    assert len(_shuffle_techniques(25, random.Random(1))) == 25

    state["config"]["challengeCount"] = 2
    state["players"]["player1"].update(score=2, attempted=2)
    state["players"]["player2"].update(score=0, attempted=1)
    assert _evaluate_winner(state) == "PLAYER 1"
    state["players"]["player1"].update(score=0, attempted=2)
    state["players"]["player2"].update(score=2, attempted=2)
    assert _evaluate_winner(state) == "PLAYER 2"
    state["players"]["player1"].update(score=1, attempted=2)
    state["players"]["player2"].update(score=1, attempted=2)
    assert _evaluate_winner(state) == "DRAW"


def test_connect_ping_join_validation_and_join_required():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()

    assert invoke_route("$connect", "connection", connections, sessions, api) == {
        "statusCode": 200,
        "body": "Connected",
    }
    assert invoke({"action": "ping"}, "connection", connections, sessions, api) == {
        "statusCode": 200,
        "body": "Pong",
    }
    assert (
        invoke({"action": "command"}, "connection", connections, sessions, api)["statusCode"] == 409
    )
    response = invoke(
        {"action": "join", "roomId": "room", "role": "invalid"},
        "connection",
        connections,
        sessions,
        api,
    )
    assert response["statusCode"] == 400
    assert api.messages("connection")[-1]["payload"]["reason"] == "Invalid role"


def test_signals_support_targeted_and_broadcast_delivery():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer", connections, sessions, api)
    join("player1", "p1", connections, sessions, api)
    join("player2", "p2", connections, sessions, api)
    api.posts.clear()

    response = invoke(
        {
            "action": "signal",
            "signalType": "offer",
            "to": "player2-client",
            "payload": {"sdp": "offer"},
        },
        "p1",
        connections,
        sessions,
        api,
    )
    assert response["statusCode"] == 200
    assert [post["ConnectionId"] for post in api.posts] == ["p2"]
    assert api.messages("p2")[0]["messageType"] == "webrtc.offer"

    api.posts.clear()
    response = invoke(
        {
            "action": "signal",
            "signalType": "iceCandidate",
            "payload": {"candidate": "candidate"},
        },
        "p1",
        connections,
        sessions,
        api,
    )
    assert response["statusCode"] == 200
    assert {post["ConnectionId"] for post in api.posts} == {"viewer", "p2"}

    response = invoke(
        {"action": "signal", "signalType": "invalid"},
        "p1",
        connections,
        sessions,
        api,
    )
    assert response["statusCode"] == 400


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ([], "WebSocket body must be an object"),
        ({"action": "unknown"}, "Unsupported WebSocket action"),
        ({"action": "command"}, "Command envelope is required"),
        (
            {
                "action": "command",
                "envelope": {"protocolVersion": "1.0"},
            },
            "Unsupported protocol version",
        ),
        (
            {
                "action": "command",
                "envelope": {
                    "protocolVersion": "2.0",
                    "roomId": "OTHER",
                },
            },
            "Command room does not match joined room",
        ),
        (
            {
                "action": "command",
                "envelope": {
                    "protocolVersion": "2.0",
                    "roomId": "ROOM",
                    "messageId": "",
                    "payload": {},
                },
            },
            "Invalid command envelope",
        ),
    ],
)
def test_invalid_messages_are_rejected(body, reason):
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer", connections, sessions, api)
    response = handle_websocket_event(
        {"body": json.dumps(body)},
        {"connectionId": "viewer", "routeKey": "$default"},
        connections_table=connections,
        sessions_table=sessions,
        api_client=api,
        logger=logging.getLogger("test"),
        metrics=MetricsEmitter(),
        clock=lambda: 100.0,
        rng=random.Random(7),
    )
    assert response["statusCode"] == 400
    assert reason in response["body"]


def test_simultaneous_scores_retry_and_merge_after_conditional_collision():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    match_id = start_playing(connections, sessions, api)
    base_state = copy.deepcopy(sessions.items["v2-room:ROOM"])
    p1_challenge = base_state["players"]["player1"]["challenge"]

    command(
        "challenge.succeeded",
        {
            "challengeId": p1_challenge["challengeId"],
            "technique": p1_challenge["technique"],
        },
        "p1",
        connections,
        sessions,
        api,
        message_id="p1-success",
        match_id=match_id,
        now=101.0,
    )
    p1_result = copy.deepcopy(sessions.items["v2-room:ROOM"])
    sessions.items["v2-room:ROOM"] = base_state
    sessions.conflict_item = p1_result
    p2_challenge = base_state["players"]["player2"]["challenge"]

    response = command(
        "challenge.succeeded",
        {
            "challengeId": p2_challenge["challengeId"],
            "technique": p2_challenge["technique"],
        },
        "p2",
        connections,
        sessions,
        api,
        message_id="p2-success",
        match_id=match_id,
        now=101.1,
    )

    state = sessions.items["v2-room:ROOM"]
    assert response["statusCode"] == 200
    assert state["players"]["player1"]["score"] == 1
    assert state["players"]["player2"]["score"] == 1
    assert {cast["role"] for cast in state["resolution"]["casts"]} == {
        "player1",
        "player2",
    }


def test_write_retry_limit_rejects_without_corrupting_state():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer", connections, sessions, api)
    before = copy.deepcopy(sessions.items["v2-room:ROOM"])
    sessions.failures = 3

    response = command(
        "match.start",
        {},
        "viewer",
        connections,
        sessions,
        api,
        message_id="start",
    )

    assert response["statusCode"] == 400
    assert "exceeded retry limit" in response["body"]
    assert sessions.items["v2-room:ROOM"] == before


def test_score_grace_deadlines_and_stale_commands_are_rejected():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    match_id = start_playing(connections, sessions, api, score_grace_ms=1000)
    state = sessions.items["v2-room:ROOM"]
    challenge = state["players"]["player1"]["challenge"]

    early_timeout = command(
        "challenge.timedOut",
        {"challengeId": challenge["challengeId"]},
        "p1",
        connections,
        sessions,
        api,
        message_id="early-timeout",
        match_id=match_id,
        now=101.0,
    )
    assert early_timeout["statusCode"] == 400

    wrong_technique = command(
        "challenge.succeeded",
        {
            "challengeId": challenge["challengeId"],
            "technique": "Unlimited Void"
            if challenge["technique"] != "Unlimited Void"
            else "Malevolent Shrine",
        },
        "p1",
        connections,
        sessions,
        api,
        message_id="wrong-technique",
        match_id=match_id,
        now=101.0,
    )
    assert wrong_technique["statusCode"] == 400

    stale_match = command(
        "challenge.succeeded",
        {},
        "p1",
        connections,
        sessions,
        api,
        message_id="stale-match",
        match_id="old-match",
    )
    assert stale_match["statusCode"] == 400
    assert stale_match["body"] == "Command match is stale"

    success = command(
        "challenge.succeeded",
        {
            "challengeId": challenge["challengeId"],
            "technique": challenge["technique"],
        },
        "p1",
        connections,
        sessions,
        api,
        message_id="success",
        match_id=match_id,
        now=101.0,
    )
    assert success["statusCode"] == 200
    p2 = sessions.items["v2-room:ROOM"]["players"]["player2"]["challenge"]
    late = command(
        "challenge.succeeded",
        {"challengeId": p2["challengeId"], "technique": p2["technique"]},
        "p2",
        connections,
        sessions,
        api,
        message_id="late",
        match_id=match_id,
        now=102.1,
    )
    assert late["statusCode"] == 400
    assert late["body"] == "Score grace window has closed"


def test_resolution_cinematic_reset_and_authorization_lifecycle():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    match_id = start_playing(connections, sessions, api)
    state = sessions.items["v2-room:ROOM"]
    for role, connection in (("player1", "p1"), ("player2", "p2")):
        challenge = state["players"][role]["challenge"]
        response = command(
            "challenge.succeeded",
            {
                "challengeId": challenge["challengeId"],
                "technique": challenge["technique"],
                "videoSrc": f"/{role}.mp4",
            },
            connection,
            connections,
            sessions,
            api,
            message_id=f"{role}-success",
            match_id=match_id,
            now=101.0,
        )
        assert response["statusCode"] == 200
        state = sessions.items["v2-room:ROOM"]

    early = command(
        "resolution.complete",
        {},
        "viewer",
        connections,
        sessions,
        api,
        message_id="early-resolution",
        match_id=match_id,
        now=101.5,
    )
    assert early["statusCode"] == 400
    resolved = command(
        "resolution.complete",
        {"expectedDurationMs": 10},
        "viewer",
        connections,
        sessions,
        api,
        message_id="resolution",
        match_id=match_id,
        now=102.1,
    )
    assert resolved["statusCode"] == 200
    state = sessions.items["v2-room:ROOM"]
    assert state["phase"] == "cinematic"
    assert state["pendingWinner"] == "DRAW"

    stale_cinematic = command(
        "cinematic.completed",
        {"cinematicId": "old"},
        "viewer",
        connections,
        sessions,
        api,
        message_id="stale-cinematic",
        match_id=match_id,
        now=103.0,
    )
    assert stale_cinematic["statusCode"] == 400
    completed = command(
        "cinematic.completed",
        {"cinematicId": state["cinematic"]["cinematicId"]},
        "viewer",
        connections,
        sessions,
        api,
        message_id="cinematic",
        match_id=match_id,
        now=103.0,
    )
    assert completed["statusCode"] == 200
    assert sessions.items["v2-room:ROOM"]["winner"] == "DRAW"

    unauthorized = command(
        "match.reset",
        {},
        "p1",
        connections,
        sessions,
        api,
        message_id="unauthorized",
    )
    assert unauthorized["statusCode"] == 400
    reset = command(
        "match.reset",
        {},
        "viewer",
        connections,
        sessions,
        api,
        message_id="reset",
    )
    assert reset["statusCode"] == 200
    assert sessions.items["v2-room:ROOM"]["phase"] == "idle"


def test_timeouts_finish_a_draw_and_disconnect_preserves_match():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    match_id = start_playing(connections, sessions, api)
    state = sessions.items["v2-room:ROOM"]
    for role, connection in (("player1", "p1"), ("player2", "p2")):
        challenge = state["players"][role]["challenge"]
        response = command(
            "challenge.timedOut",
            {"challengeId": challenge["challengeId"]},
            connection,
            connections,
            sessions,
            api,
            message_id=f"{role}-timeout",
            match_id=match_id,
            now=109.0,
        )
        assert response["statusCode"] == 200
        state = sessions.items["v2-room:ROOM"]
    assert state["phase"] == "ended"
    assert state["winner"] == "DRAW"

    sessions.failures = 1
    response = invoke_route("$disconnect", "p1", connections, sessions, api, now=110.0)
    assert response["statusCode"] == 200
    assert sessions.items["v2-room:ROOM"]["players"]["player1"] == {
        "connected": False,
        "clientId": None,
        "score": 0,
        "attempted": 1,
        "finished": True,
        "challenge": None,
    }


def test_join_retries_a_conditional_write_collision():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    sessions.failures = 1
    api = ApiClient()

    join("player1", "p1", connections, sessions, api)

    state = sessions.items["v2-room:ROOM"]
    assert sessions.put_calls == 2
    assert state["players"]["player1"]["connected"] is True


def test_processed_command_history_is_bounded():
    connections = ConnectionsTable()
    sessions = SessionsTable()
    api = ApiClient()
    join("viewer", "viewer", connections, sessions, api)
    state = sessions.items["v2-room:ROOM"]
    state["processedCommands"] = {f"old-{index}": index for index in range(201)}
    sessions.items["v2-room:ROOM"] = state

    response = command(
        "match.start",
        {},
        "viewer",
        connections,
        sessions,
        api,
        message_id="new",
    )

    assert response["statusCode"] == 200
    processed = sessions.items["v2-room:ROOM"]["processedCommands"]
    assert len(processed) == 152
    assert "new" in processed


def test_unexpected_storage_failure_returns_generic_error():
    class BrokenConnections(ConnectionsTable):
        def get_item(self, Key):
            raise OSError("storage unavailable")

    response = invoke(
        {"action": "command"},
        "viewer",
        BrokenConnections(),
        SessionsTable(),
        ApiClient(),
    )
    assert response == {
        "statusCode": 500,
        "body": "WebSocket action failed",
    }
