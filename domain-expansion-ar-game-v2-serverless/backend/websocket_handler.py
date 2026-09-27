"""Authoritative WebSocket coordinator for Domain Expansion V2."""

from __future__ import annotations

import copy
import json
import logging
import random
import time
import uuid
from decimal import Decimal
from typing import Any, Callable

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from observability import Metric, MetricsEmitter


PROTOCOL_VERSION = "2.0"
TECHNIQUES = [
    "Unlimited Void",
    "Malevolent Shrine",
    "Self-Embodiment of Perfection",
    "Authentic Mutual Love",
    "Idle Death Gamble",
    "Yuji Itadori",
    "Chimera Shadow Garden",
    "Time Cell Moon Palace",
    "Lapse Blue",
    "Reversal Red",
    "Hollow Purple",
]
PLAYER_ROLES = {"player1", "player2"}


def _normalize(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    return value


def _now_ms(clock: Callable[[], float]) -> int:
    return int(clock() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _room_key(room_id: str) -> str:
    return f"v2-room:{room_id}"


def _default_player() -> dict[str, Any]:
    return {
        "connected": False,
        "clientId": None,
        "score": 0,
        "attempted": 0,
        "finished": False,
        "challenge": None,
    }


def _default_state(room_id: str, now_ms: int) -> dict[str, Any]:
    return {
        "session_id": _room_key(room_id),
        "entityType": "v2-match",
        "protocolVersion": PROTOCOL_VERSION,
        "roomId": room_id,
        "matchId": None,
        "revision": 0,
        "phase": "idle",
        "config": {
            "difficultySeconds": 8,
            "challengeCount": 11,
            "countdownSeconds": 3,
            "scoreGraceMs": 1000,
            "synchronizedGestures": False,
        },
        "players": {
            "player1": _default_player(),
            "player2": _default_player(),
        },
        "challengeLists": {"player1": [], "player2": []},
        "countdownEndsAt": None,
        "resolution": None,
        "cinematic": None,
        "winner": None,
        "pendingWinner": None,
        "processedCommands": {},
        "updatedAt": now_ms,
        "ttl": int(now_ms / 1000) + 86400,
    }


def _public_state(state: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(state)
    result.pop("session_id", None)
    result.pop("entityType", None)
    result.pop("challengeLists", None)
    result.pop("processedCommands", None)
    result.pop("ttl", None)
    return result


def _shuffle_techniques(count: int, rng: random.Random) -> list[str]:
    result: list[str] = []
    while len(result) < count:
        batch = TECHNIQUES.copy()
        rng.shuffle(batch)
        result.extend(batch)
    return result[:count]


def _assign_challenge(
    state: dict[str, Any], role: str, now_ms: int, *, preserve_deadline: bool = False
) -> None:
    player = state["players"][role]
    if player["attempted"] >= state["config"]["challengeCount"]:
        player["finished"] = True
        player["challenge"] = None
        return
    if player.get("challenge") and preserve_deadline:
        return
    techniques = state["challengeLists"][role]
    technique = techniques[player["attempted"]]
    player["challenge"] = {
        "challengeId": _new_id("challenge"),
        "technique": technique,
        "startedAt": now_ms,
        "deadlineAt": now_ms + state["config"]["difficultySeconds"] * 1000,
        "pausedRemainingMs": None,
    }


def _pause_challenges(state: dict[str, Any], now_ms: int) -> None:
    for player in state["players"].values():
        challenge = player.get("challenge")
        if challenge:
            challenge["pausedRemainingMs"] = max(
                0, int(challenge["deadlineAt"]) - now_ms
            )
            challenge["deadlineAt"] = None


def _resume_challenges(state: dict[str, Any], now_ms: int) -> None:
    for role in PLAYER_ROLES:
        player = state["players"][role]
        challenge = player.get("challenge")
        if challenge:
            remaining = challenge.pop("pausedRemainingMs", None)
            challenge["deadlineAt"] = now_ms + max(
                0, int(remaining or state["config"]["difficultySeconds"] * 1000)
            )
        elif not player["finished"]:
            _assign_challenge(state, role, now_ms)


def _evaluate_winner(state: dict[str, Any]) -> str | None:
    p1 = state["players"]["player1"]
    p2 = state["players"]["player2"]
    count = state["config"]["challengeCount"]
    p1["finished"] = p1["attempted"] >= count
    p2["finished"] = p2["attempted"] >= count

    p1_max = p1["score"] + max(0, count - p1["attempted"])
    p2_max = p2["score"] + max(0, count - p2["attempted"])
    if p1["finished"] and not p2["finished"] and p1["score"] > p2_max:
        return "PLAYER 1"
    if p2["finished"] and not p1["finished"] and p2["score"] > p1_max:
        return "PLAYER 2"
    if not (p1["finished"] and p2["finished"]):
        return None
    if p1["score"] == p2["score"]:
        return "DRAW"
    return "PLAYER 1" if p1["score"] > p2["score"] else "PLAYER 2"


def _command_error(message: str) -> ValueError:
    return ValueError(message)


def _require_phase(state: dict[str, Any], *phases: str) -> None:
    if state["phase"] not in phases:
        raise _command_error(
            f"Command is not valid while match phase is {state['phase']}"
        )


def _apply_command(
    state: dict[str, Any],
    command_type: str,
    payload: dict[str, Any],
    role: str,
    now_ms: int,
    rng: random.Random,
) -> None:
    viewer_commands = {
        "match.start",
        "match.countdownCompleted",
        "match.reset",
        "resolution.complete",
        "cinematic.completed",
    }
    if command_type in viewer_commands and role != "viewer":
        raise _command_error("Only the viewer can issue match-control commands")

    if command_type == "match.start":
        _require_phase(state, "idle", "ended")
        requested = payload.get("config") or {}
        difficulty = max(1, min(120, int(requested.get("difficultySeconds", 8))))
        count = max(1, min(100, int(requested.get("challengeCount", 11))))
        countdown = max(0, min(30, int(requested.get("countdownSeconds", 3))))
        score_grace = max(0, min(5000, int(requested.get("scoreGraceMs", 1000))))
        synchronized = bool(requested.get("synchronizedGestures", False))

        state["matchId"] = _new_id("match")
        state["phase"] = "countdown"
        state["config"] = {
            "difficultySeconds": difficulty,
            "challengeCount": count,
            "countdownSeconds": countdown,
            "scoreGraceMs": score_grace,
            "synchronizedGestures": synchronized,
        }
        state["winner"] = None
        state["pendingWinner"] = None
        state["resolution"] = None
        state["cinematic"] = None
        for player_role in PLAYER_ROLES:
            connected = state["players"][player_role]["connected"]
            client_id = state["players"][player_role]["clientId"]
            state["players"][player_role] = _default_player()
            state["players"][player_role]["connected"] = connected
            state["players"][player_role]["clientId"] = client_id

        shared = _shuffle_techniques(count, rng)
        state["challengeLists"]["player1"] = shared
        state["challengeLists"]["player2"] = (
            shared.copy() if synchronized else _shuffle_techniques(count, rng)
        )
        state["countdownEndsAt"] = now_ms + countdown * 1000
        return

    if command_type == "match.countdownCompleted":
        _require_phase(state, "countdown")
        if now_ms < int(state.get("countdownEndsAt") or 0):
            raise _command_error("Countdown has not completed")
        state["phase"] = "playing"
        state["countdownEndsAt"] = None
        for player_role in PLAYER_ROLES:
            _assign_challenge(state, player_role, now_ms)
        return

    if command_type == "match.reset":
        connected = {
            player_role: {
                "connected": state["players"][player_role]["connected"],
                "clientId": state["players"][player_role]["clientId"],
            }
            for player_role in PLAYER_ROLES
        }
        reset = _default_state(state["roomId"], now_ms)
        for player_role in PLAYER_ROLES:
            reset["players"][player_role].update(connected[player_role])
        state.clear()
        state.update(reset)
        return

    if command_type == "challenge.succeeded":
        _require_phase(state, "playing", "resolving")
        if role not in PLAYER_ROLES:
            raise _command_error("Only players can submit challenge results")
        if state["phase"] == "resolving" and now_ms > int(
            state["resolution"]["acceptUntil"]
        ):
            raise _command_error("Score grace window has closed")

        player = state["players"][role]
        challenge = player.get("challenge")
        if not challenge or challenge["challengeId"] != payload.get("challengeId"):
            raise _command_error("Challenge is stale or does not belong to player")
        if challenge.get("deadlineAt") and now_ms > int(challenge["deadlineAt"]):
            raise _command_error("Challenge deadline has passed")
        if payload.get("technique") != challenge["technique"]:
            raise _command_error("Technique does not match active challenge")

        if state["phase"] == "playing":
            _pause_challenges(state, now_ms)
            state["phase"] = "resolving"
            state["resolution"] = {
                "resolutionId": _new_id("resolution"),
                "acceptUntil": now_ms + state["config"]["scoreGraceMs"],
                "casts": [],
            }

        player["score"] += 1
        player["attempted"] += 1
        player["challenge"] = None
        state["resolution"]["casts"].append(
            {
                "role": role,
                "technique": payload["technique"],
                "videoSrc": payload.get("videoSrc"),
            }
        )
        return

    if command_type == "challenge.timedOut":
        _require_phase(state, "playing")
        if role not in PLAYER_ROLES:
            raise _command_error("Only players can time out challenges")
        player = state["players"][role]
        challenge = player.get("challenge")
        if not challenge or challenge["challengeId"] != payload.get("challengeId"):
            raise _command_error("Challenge is stale or does not belong to player")
        if now_ms < int(challenge["deadlineAt"]):
            raise _command_error("Challenge deadline has not passed")
        player["attempted"] += 1
        player["challenge"] = None
        winner = _evaluate_winner(state)
        if winner:
            state["winner"] = winner
            state["phase"] = "ended"
        else:
            _assign_challenge(state, role, now_ms)
        return

    if command_type == "resolution.complete":
        _require_phase(state, "resolving")
        if now_ms < int(state["resolution"]["acceptUntil"]):
            raise _command_error("Score grace window has not completed")
        winner = _evaluate_winner(state)
        state["pendingWinner"] = winner
        state["cinematic"] = {
            "cinematicId": _new_id("cinematic"),
            "casts": state["resolution"]["casts"],
            "startedAt": now_ms,
            "fallbackEndsAt": now_ms
            + max(5000, int(payload.get("expectedDurationMs", 15000)) + 1000),
        }
        state["resolution"] = None
        state["phase"] = "cinematic"
        return

    if command_type == "cinematic.completed":
        _require_phase(state, "cinematic")
        cinematic = state.get("cinematic")
        if not cinematic or cinematic["cinematicId"] != payload.get("cinematicId"):
            raise _command_error("Cinematic is stale")
        state["cinematic"] = None
        if state.get("pendingWinner"):
            state["winner"] = state["pendingWinner"]
            state["pendingWinner"] = None
            state["phase"] = "ended"
        else:
            state["phase"] = "playing"
            _resume_challenges(state, now_ms)
        return

    raise _command_error(f"Unsupported command type: {command_type}")


def handle_websocket_event(
    event: dict[str, Any],
    request_context: dict[str, Any],
    *,
    connections_table: Any,
    sessions_table: Any,
    api_client: Any,
    logger: logging.Logger,
    metrics: MetricsEmitter,
    clock: Callable[[], float] = time.time,
    rng: random.Random | None = None,
) -> dict[str, Any]:
    connection_id = request_context.get("connectionId")
    route_key = request_context.get("routeKey")
    randomizer = rng or random.SystemRandom()

    def post(target_id: str, message: dict[str, Any]) -> None:
        try:
            api_client.post_to_connection(
                ConnectionId=target_id,
                Data=json.dumps(_normalize(message)),
            )
        except Exception:
            metrics.emit(Metric("WebSocketDeliveryFailure"), route=str(route_key))
            logger.exception("Unable to deliver V2 WebSocket message")

    def room_connections(room_id: str) -> list[dict[str, Any]]:
        response = connections_table.query(
            IndexName="RoomCodeIndex",
            KeyConditionExpression=Key("room_code").eq(room_id),
        )
        return response.get("Items", [])

    def load_state(room_id: str) -> dict[str, Any]:
        item = sessions_table.get_item(Key={"session_id": _room_key(room_id)}).get(
            "Item"
        )
        return _normalize(item) if item else _default_state(room_id, _now_ms(clock))

    def save_state(state: dict[str, Any], expected_revision: int) -> None:
        state["revision"] = expected_revision + 1
        state["updatedAt"] = _now_ms(clock)
        state["ttl"] = int(clock()) + 86400
        try:
            sessions_table.put_item(
                Item=state,
                ConditionExpression=(
                    "attribute_not_exists(session_id) OR revision = :expected"
                ),
                ExpressionAttributeValues={":expected": expected_revision},
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise RuntimeError("Concurrent room update; retry command") from error
            raise

    def envelope(
        message_type: str,
        room_id: str,
        state: dict[str, Any],
        payload: dict[str, Any],
        *,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "messageId": _new_id("event"),
            "messageType": message_type,
            "roomId": room_id,
            "matchId": state.get("matchId"),
            "revision": state.get("revision", 0),
            "sentAt": _now_ms(clock),
            "correlationId": correlation_id,
            "payload": payload,
        }

    def publish_snapshot(
        room_id: str, state: dict[str, Any], correlation_id: str | None = None
    ) -> None:
        message = envelope(
            "room.snapshot",
            room_id,
            state,
            {"state": _public_state(state)},
            correlation_id=correlation_id,
        )
        for connection in room_connections(room_id):
            target = connection.get("connection_id")
            if isinstance(target, str):
                post(target, message)

    if route_key == "$connect":
        return {"statusCode": 200, "body": "Connected"}

    if route_key == "$disconnect":
        record = connections_table.get_item(
            Key={"connection_id": connection_id}
        ).get("Item")
        if record:
            connections_table.delete_item(Key={"connection_id": connection_id})
            room_id = record.get("room_code")
            role = record.get("role")
            if room_id and role in PLAYER_ROLES:
                state = load_state(room_id)
                expected_revision = state["revision"]
                state["players"][role]["connected"] = False
                state["players"][role]["clientId"] = None
                save_state(state, expected_revision)
                publish_snapshot(room_id, state)
        return {"statusCode": 200, "body": "Disconnected"}

    try:
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict):
            raise ValueError("WebSocket body must be an object")
        action = body.get("action")
        if action == "ping":
            return {"statusCode": 200, "body": "Pong"}

        if action == "join":
            room_id = str(body.get("roomId") or "BTL1").strip().upper()
            role = str(body.get("role") or "viewer")
            client_id = str(body.get("clientId") or _new_id("client"))
            if role not in {"viewer", *PLAYER_ROLES}:
                raise ValueError("Invalid role")
            connections_table.put_item(
                Item={
                    "connection_id": connection_id,
                    "client_id": client_id,
                    "room_code": room_id,
                    "role": role,
                    "created_at": int(clock()),
                    "ttl": int(clock()) + 86400,
                }
            )
            state = load_state(room_id)
            expected_revision = state["revision"]
            if role in PLAYER_ROLES:
                state["players"][role]["connected"] = True
                state["players"][role]["clientId"] = client_id
            save_state(state, expected_revision)
            publish_snapshot(room_id, state)
            return {"statusCode": 200, "body": "Joined"}

        sender = connections_table.get_item(
            Key={"connection_id": connection_id}
        ).get("Item")
        if not sender:
            return {"statusCode": 409, "body": "Join the room first"}
        room_id = sender["room_code"]

        if action == "signal":
            state = load_state(room_id)
            signal_type = str(body.get("signalType") or "")
            if signal_type not in {
                "playerReady",
                "viewerRequested",
                "offer",
                "answer",
                "iceCandidate",
                "peerClosed",
            }:
                raise ValueError("Unsupported WebRTC signal")
            message = envelope(
                f"webrtc.{signal_type}",
                room_id,
                state,
                {
                    "from": sender.get("client_id"),
                    "role": sender.get("role"),
                    "data": body.get("payload"),
                },
            )
            target_client = body.get("to")
            for connection in room_connections(room_id):
                target_id = connection.get("connection_id")
                should_send = (
                    connection.get("client_id") == target_client
                    if target_client
                    else target_id != connection_id
                )
                if should_send and isinstance(target_id, str):
                    post(target_id, message)
            return {"statusCode": 200, "body": "Signaled"}

        if action != "command":
            raise ValueError("Unsupported WebSocket action")

        command = body.get("envelope")
        if not isinstance(command, dict):
            raise ValueError("Command envelope is required")
        if command.get("protocolVersion") != PROTOCOL_VERSION:
            raise ValueError("Unsupported protocol version")
        if command.get("roomId") != room_id:
            raise ValueError("Command room does not match joined room")

        message_id = str(command.get("messageId") or "")
        command_type = str(command.get("messageType") or "")
        payload = command.get("payload") or {}
        if not message_id or not isinstance(payload, dict):
            raise ValueError("Invalid command envelope")

        state = load_state(room_id)
        expected_revision = state["revision"]
        if message_id in state["processedCommands"]:
            post(
                connection_id,
                envelope(
                    "command.acknowledged",
                    room_id,
                    state,
                    {"duplicate": True},
                    correlation_id=message_id,
                ),
            )
            return {"statusCode": 200, "body": "Duplicate ignored"}
        if (
            state.get("matchId")
            and command_type not in {"match.start", "match.reset"}
            and command.get("matchId") != state.get("matchId")
        ):
            raise ValueError("Command match is stale")

        _apply_command(
            state,
            command_type,
            payload,
            str(sender.get("role")),
            _now_ms(clock),
            randomizer,
        )
        state["processedCommands"][message_id] = int(clock())
        if len(state["processedCommands"]) > 200:
            oldest = sorted(
                state["processedCommands"],
                key=state["processedCommands"].get,
            )[:50]
            for old_message_id in oldest:
                state["processedCommands"].pop(old_message_id, None)
        save_state(state, expected_revision)
        publish_snapshot(room_id, state, message_id)
        return {"statusCode": 200, "body": "Command accepted"}
    except (TypeError, ValueError, RuntimeError) as error:
        metrics.emit(Metric("WebSocketCommandRejected"))
        logger.warning("V2 WebSocket command rejected: %s", error)
        if connection_id:
            fallback_room = locals().get("room_id", "")
            fallback_state = (
                load_state(fallback_room)
                if fallback_room
                else _default_state("", _now_ms(clock))
            )
            post(
                connection_id,
                envelope(
                    "command.rejected",
                    fallback_room,
                    fallback_state,
                    {"reason": str(error)},
                ),
            )
        return {"statusCode": 400, "body": str(error)}
    except Exception:
        metrics.emit(Metric("WebSocketActionFailure"))
        logger.exception("V2 WebSocket action failed")
        return {"statusCode": 500, "body": "WebSocket action failed"}
