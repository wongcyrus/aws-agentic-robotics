"""Plain Lambda tool target for robot-only AgentCore Gateway access."""

import json
import logging
from typing import Any

from models import RobotID
from executors import robot_executor
from tools.speech_tools import execute_robot_speak
from tools.image_tools import execute_get_image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


_ALLOWED_ROBOT_IDS = {robot_id.value for robot_id in RobotID}

_ROBOT_TOOL_CONFIG: dict[str, dict[str, str]] = {
    "robot_go_forward": {
        "action": "go_forward",
        "message": "The robot is moving forward.",
    },
    "robot_back_fast": {
        "action": "back_fast",
        "message": "The robot is moving backward quickly.",
    },
    "robot_left_move_fast": {
        "action": "left_move_fast",
        "message": "The robot is moving left quickly.",
    },
    "robot_right_move_fast": {
        "action": "right_move_fast",
        "message": "The robot is moving right quickly.",
    },
    "robot_stand": {
        "action": "stand",
        "message": "The robot is standing up.",
    },
    "robot_squat": {
        "action": "squat",
        "message": "The robot is squatting down.",
    },
    "robot_squat_up": {
        "action": "squat_up",
        "message": "The robot is standing up from a squat.",
    },
    "robot_stand_up_back": {
        "action": "stand_up_back",
        "message": "The robot is standing up from the back.",
    },
    "robot_stand_up_front": {
        "action": "stand_up_front",
        "message": "The robot is standing up from the front.",
    },
    "robot_bow": {
        "action": "bow",
        "message": "The robot is bowing.",
    },
    "robot_push_ups": {
        "action": "push_ups",
        "message": "The robot is performing push-ups.",
    },
    "robot_sit_ups": {
        "action": "sit_ups",
        "message": "The robot is performing sit-ups.",
    },
    "robot_chest": {
        "action": "chest",
        "message": "The robot is performing chest exercises.",
    },
    "robot_stepping": {
        "action": "stepping",
        "message": "The robot is performing stepping motions.",
    },
    "robot_left_kick": {
        "action": "left_kick",
        "message": "The robot is performing a left kick.",
    },
    "robot_right_kick": {
        "action": "right_kick",
        "message": "The robot is performing a right kick.",
    },
    "robot_left_shot_fast": {
        "action": "left_shot_fast",
        "message": "The robot is performing a fast left punch.",
    },
    "robot_right_shot_fast": {
        "action": "right_shot_fast",
        "message": "The robot is performing a fast right punch.",
    },
    "robot_left_uppercut": {
        "action": "left_uppercut",
        "message": "The robot is performing a left uppercut.",
    },
    "robot_right_uppercut": {
        "action": "right_uppercut",
        "message": "The robot is performing a right uppercut.",
    },
    "robot_kung_fu": {
        "action": "kung_fu",
        "message": "The robot is performing kung fu moves.",
    },
    "robot_wing_chun": {
        "action": "wing_chun",
        "message": "The robot is performing Wing Chun moves.",
    },
    "robot_weightlifting": {
        "action": "weightlifting",
        "message": "The robot is performing weightlifting.",
    },
    "robot_turn_left": {
        "action": "turn_left",
        "message": "The robot is turning left.",
    },
    "robot_turn_right": {
        "action": "turn_right",
        "message": "The robot is turning right.",
    },
    "robot_twist": {
        "action": "twist",
        "message": "The robot is twisting its body.",
    },
    "robot_wave": {
        "action": "wave",
        "message": "The robot is waving its hand.",
    },
    "robot_stop": {
        "action": "stop",
        "message": "The robot has stopped.",
    },
    "robot_dance_one": {
        "action": "dance_ten",
        "message": "The robot is performing dance one.",
    },
    "robot_dance_two": {
        "action": "dance_two",
        "message": "The robot is performing dance two.",
    },
    "robot_dance_three": {
        "action": "dance_three",
        "message": "The robot is performing dance three.",
    },
    "robot_dance_four": {
        "action": "dance_four",
        "message": "The robot is performing dance four.",
    },
    "robot_dance_five": {
        "action": "dance_five",
        "message": "The robot is performing dance five.",
    },
    "robot_dance_six": {
        "action": "dance_six",
        "message": "The robot is performing dance six.",
    },
    "robot_dance_seven": {
        "action": "dance_seven",
        "message": "The robot is performing dance seven.",
    },
    "robot_dance_eight": {
        "action": "dance_eight",
        "message": "The robot is performing dance eight.",
    },
    "robot_dance_nine": {
        "action": "dance_nine",
        "message": "The robot is performing dance nine.",
    },
    "robot_dance_ten": {
        "action": "dance_ten",
        "message": "The robot is performing dance ten.",
    },
}


def _response(status_code: int, body: Any) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "body": json.dumps(body),
        "headers": {"Content-Type": "application/json"},
    }


def _normalize_tool_name(tool_name: str) -> str:
    if "___" in tool_name:
        return tool_name.split("___", 1)[1]
    return tool_name


def _mapping_value(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _candidate_tool_names(context: Any, event: Any) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    client_context = getattr(context, "client_context", None)
    custom = getattr(client_context, "custom", None)
    value = _mapping_value(custom, "bedrockAgentCoreToolName")
    if isinstance(value, str) and value.strip():
        candidates.append(("context.client_context.custom.bedrockAgentCoreToolName", value.strip()))

    value = _mapping_value(context, "bedrockAgentCoreToolName")
    if isinstance(value, str) and value.strip():
        candidates.append(("context.bedrockAgentCoreToolName", value.strip()))

    return candidates


_SPECIAL_TOOLS = {"robot_speak", "robot_see", "get_image"}


def _extract_tool_name(context: Any, event: Any) -> str:
    candidates = _candidate_tool_names(context, event)
    first_candidate: tuple[str, str] | None = None
    for source, tool_name in candidates:
        normalized_tool_name = _normalize_tool_name(tool_name)
        if first_candidate is None:
            first_candidate = (source, normalized_tool_name)
        if normalized_tool_name in _ROBOT_TOOL_CONFIG or normalized_tool_name in _SPECIAL_TOOLS:
            logger.info(
                "Resolved robot tool name from %s. raw_tool_name=%s normalized_tool_name=%s",
                source,
                tool_name,
                normalized_tool_name,
            )
            return normalized_tool_name

    if first_candidate is not None:
        source, normalized_tool_name = first_candidate
        logger.warning(
            "Resolved unsupported robot tool name from %s. normalized_tool_name=%s",
            source,
            normalized_tool_name,
        )
        return normalized_tool_name

    raise ValueError(
        "Gateway request is missing a supported tool name. "
        f"candidate_locations={[(source, value) for source, value in candidates]}"
    )


def _extract_payload(event: Any) -> dict[str, Any]:
    if event is None:
        return {}

    if isinstance(event, dict):
        body = event.get("body")
        if isinstance(body, str):
            parsed_body = json.loads(body)
            if not isinstance(parsed_body, dict):
                raise ValueError("Tool input event body must be a JSON object.")
            return parsed_body
        if isinstance(body, dict):
            return body
        return event

    raise ValueError("Tool input event must be a JSON object.")


def _extract_robot_id(payload: dict[str, Any]) -> str:
    raw_robot_id = payload.get("robot_id", payload.get("robotId"))
    if not isinstance(raw_robot_id, str) or not raw_robot_id.strip():
        raise ValueError("Tool input must include robot_id.")

    robot_id = raw_robot_id.strip().lower()
    if robot_id not in _ALLOWED_ROBOT_IDS:
        allowed_values = ", ".join(sorted(_ALLOWED_ROBOT_IDS))
        raise ValueError(f"robot_id must be one of: {allowed_values}.")

    return robot_id


def _summarize_event(event: Any) -> dict[str, Any]:
    if isinstance(event, dict):
        body = event.get("body")
        return {
            "event_keys": sorted(event.keys()),
            "body_type": type(body).__name__ if body is not None else "missing",
            "request_context_keys": sorted(event.get("requestContext", {}).keys())
            if isinstance(event.get("requestContext"), dict)
            else [],
            "client_context_keys": sorted(event.get("clientContext", {}).keys())
            if isinstance(event.get("clientContext"), dict)
            else [],
        }
    return {"event_type": type(event).__name__}


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Dispatch the robot tool requested by AgentCore Gateway."""
    try:
        tool_name = _extract_tool_name(context, event)
        logger.info(
            "Robot tool Lambda invoked. tool_name=%s summary=%s",
            tool_name,
            _summarize_event(event),
        )

        payload = _extract_payload(event)
        robot_id = _extract_robot_id(payload)

        if tool_name == "robot_speak":
            text = payload.get("text", "")
            language = payload.get("language", "yue")
            logger.info("Dispatching robot_speak tool. robot_id=%s text=%s language=%s", robot_id, text, language)
            result_str = execute_robot_speak(robot_id, text, language)
            return _response(200, result_str)

        elif tool_name in ("robot_see", "get_image"):
            logger.info("Dispatching get_image/robot_see tool. robot_id=%s", robot_id)
            result_str = execute_get_image(robot_id)
            return _response(200, result_str)

        tool_config = _ROBOT_TOOL_CONFIG.get(tool_name)
        if tool_config is None:
            logger.error(
                "Unknown robot tool requested by gateway. tool_name=%s available_tools=%s",
                tool_name,
                sorted(_ROBOT_TOOL_CONFIG.keys()),
            )
            return _response(400, {"error": f"Unknown robot tool: {tool_name}"})

        logger.info(
            "Dispatching robot tool. tool_name=%s action=%s robot_id=%s payload_keys=%s",
            tool_name,
            tool_config["action"],
            robot_id,
            sorted(payload.keys()),
        )

        published = robot_executor.execute_action(robot_id, tool_config["action"])
        if not published:
            logger.error(
                "Robot action publish failed. tool_name=%s action=%s robot_id=%s",
                tool_name,
                tool_config["action"],
                robot_id,
            )
            return _response(
                502,
                {"error": f"Failed to publish robot action for tool: {tool_name}"},
            )

        logger.info(
            "Robot action publish succeeded. tool_name=%s action=%s robot_id=%s",
            tool_name,
            tool_config["action"],
            robot_id,
        )
        return _response(200, tool_config["message"])
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.exception("Robot tool Lambda request failed.")
        return _response(400, {"error": str(exc)})
