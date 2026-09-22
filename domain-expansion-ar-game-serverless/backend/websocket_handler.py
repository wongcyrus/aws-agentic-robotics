"""WebSocket routing for the Domain Expansion API."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

from boto3.dynamodb.conditions import Key
from observability import Metric, MetricsEmitter


def handle_websocket_event(
    event: dict[str, Any],
    request_context: dict[str, Any],
    *,
    connections_table: Any,
    api_client: Any,
    logger: logging.Logger,
    metrics: MetricsEmitter,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    connection_id = request_context.get("connectionId")
    route_key = request_context.get("routeKey")
    logger.info(
        "WebSocket request connection_id=%s route_key=%s",
        connection_id,
        route_key,
    )

    def post_to_connection(target_connection_id: str, data: dict[str, Any]) -> None:
        try:
            api_client.post_to_connection(
                ConnectionId=target_connection_id,
                Data=json.dumps(data),
            )
        except Exception:
            metrics.emit(Metric("WebSocketDeliveryFailure"), route=str(route_key))
            logger.exception(
                "Could not post to WebSocket connection connection_id=%s",
                target_connection_id,
            )

    def query_room_connections(room_code: str) -> list[dict[str, Any]]:
        try:
            response = connections_table.query(
                IndexName="RoomCodeIndex",
                KeyConditionExpression=Key("room_code").eq(room_code),
            )
            return response.get("Items", [])
        except Exception:
            metrics.emit(Metric("WebSocketConnectionQueryFailure"))
            logger.exception("Error querying room connections")
            return []

    if route_key == "$connect":
        return {"statusCode": 200, "body": "Connected."}

    if route_key == "$disconnect":
        try:
            record = connections_table.get_item(Key={"connection_id": connection_id}).get("Item")
            if record:
                connections_table.delete_item(Key={"connection_id": connection_id})
                for connection in query_room_connections(record.get("room_code")):
                    target_id = connection.get("connection_id")
                    if isinstance(target_id, str) and target_id != connection_id:
                        post_to_connection(
                            target_id,
                            {
                                "type": "user_left",
                                "data": {
                                    "id": record.get("client_id"),
                                    "role": record.get("role"),
                                },
                            },
                        )
        except Exception:
            metrics.emit(Metric("WebSocketDisconnectFailure"))
            logger.exception("Error during disconnect cleanup")
        return {"statusCode": 200, "body": "Disconnected."}

    try:
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict):
            raise ValueError("WebSocket body must be a JSON object")
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        return {"statusCode": 400, "body": f"Invalid WebSocket request: {error}"}

    try:
        action = body.get("action")
        if action == "join_room":
            room_code = body.get("roomCode", "BTL1")
            role = body.get("role", "viewer")
            client_id = body.get("client_id", "anonymous")
            connections_table.put_item(
                Item={
                    "connection_id": connection_id,
                    "client_id": client_id,
                    "room_code": room_code,
                    "role": role,
                    "created_at": int(clock()),
                }
            )
            for connection in query_room_connections(room_code):
                target_id = connection.get("connection_id")
                if isinstance(target_id, str) and target_id != connection_id:
                    post_to_connection(
                        target_id,
                        {
                            "type": "user_joined",
                            "data": {"id": client_id, "role": role},
                        },
                    )
            return {"statusCode": 200, "body": "OK"}

        if action == "signal":
            sender = connections_table.get_item(Key={"connection_id": connection_id}).get("Item")
            if not sender:
                return {"statusCode": 404, "body": "Sender missing"}

            payload = {
                "type": "signal",
                "data": {
                    "from": sender.get("client_id"),
                    "role": sender.get("role"),
                    "type": body.get("type"),
                    "data": body.get("data"),
                },
            }
            target_client = body.get("to")
            for connection in query_room_connections(sender.get("room_code")):
                target_id = connection.get("connection_id")
                should_send = (
                    connection.get("client_id") == target_client
                    if target_client
                    else target_id != connection_id
                )
                if should_send and isinstance(target_id, str):
                    post_to_connection(target_id, payload)
    except Exception:
        metrics.emit(Metric("WebSocketActionFailure"), action=str(body.get("action")))
        logger.exception("WebSocket action failed")
        return {"statusCode": 500, "body": "WebSocket action failed"}

    return {"statusCode": 200, "body": "OK"}
