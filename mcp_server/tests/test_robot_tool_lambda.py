import json
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)

mutagen_module = types.ModuleType("mutagen")
mutagen_mp3_module = types.ModuleType("mutagen.mp3")
mutagen_mp3_module.MP3 = object
sys.modules.setdefault("mutagen", mutagen_module)
sys.modules.setdefault("mutagen.mp3", mutagen_mp3_module)

import services
iot_service_module = types.ModuleType("services.iot_service")
iot_service_module.execute_robot_action = lambda *args, **kwargs: True
iot_service_module.iot_client = SimpleNamespace(publish=lambda *args, **kwargs: None)
polly_service_module = types.ModuleType("services.polly_service")
polly_service_module.synthesize_and_upload = lambda *args, **kwargs: None
polly_service_module.VOICE_MAP = {
    "yue": {"voice_id": "Hiujin", "engine": "neural", "language_code": "yue-CN"},
    "en": {"voice_id": "Joanna", "engine": "neural", "language_code": "en-US"},
}
sys.modules["services.iot_service"] = iot_service_module
sys.modules["services.polly_service"] = polly_service_module

import robot_tool_lambda


def _context(tool_name: str):
    return SimpleNamespace(
        client_context=SimpleNamespace(
            custom={"bedrockAgentCoreToolName": tool_name},
        )
    )


class RobotToolLambdaTests(unittest.TestCase):
    @patch.object(robot_tool_lambda.robot_executor, "execute_action", return_value=True)
    def test_dispatches_robot_tool(self, execute_action):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_2"},
            _context("robot_wave"),
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"]), "The robot is waving its hand.")
        execute_action.assert_called_once_with("robot_2", "wave")

    @patch.object(robot_tool_lambda.robot_executor, "execute_action", return_value=True)
    def test_accepts_lambda_body_payload(self, execute_action):
        response = robot_tool_lambda.lambda_handler(
            {"body": '{"robot_id":"robot_3"}'},
            _context("robot_turn_left"),
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"]), "The robot is turning left.")
        execute_action.assert_called_once_with("robot_3", "turn_left")

    @patch.object(robot_tool_lambda.robot_executor, "execute_action", return_value=True)
    def test_accepts_tool_name_from_context_attributes(self, execute_action):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_6"},
            SimpleNamespace(
                client_context=None,
                bedrockAgentCoreToolName="robot-only-mcp-lambda___robot_wave",
            ),
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"]), "The robot is waving its hand.")
        execute_action.assert_called_once_with("robot_6", "wave")

    def test_rejects_unknown_tool(self):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_1"},
            _context("robot_unknown"),
        )

        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            json.loads(response["body"]),
            {"error": "Unknown robot tool: robot_unknown"},
        )

    def test_rejects_invalid_robot_id(self):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_999"},
            _context("robot_stop"),
        )

        self.assertEqual(response["statusCode"], 400)
        self.assertIn("robot_id must be one of:", json.loads(response["body"])["error"])

    @patch.object(robot_tool_lambda.robot_executor, "execute_action", return_value=False)
    def test_surfaces_publish_failure(self, execute_action):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_1"},
            _context("robot_stop"),
        )

        self.assertEqual(response["statusCode"], 502)
        self.assertEqual(
            json.loads(response["body"]),
            {"error": "Failed to publish robot action for tool: robot_stop"},
        )
        execute_action.assert_called_once_with("robot_1", "stop")

    def test_rejects_tool_name_outside_context_contract(self):
        response = robot_tool_lambda.lambda_handler(
            {
                "robot_id": "robot_5",
                "headers": {
                    "x-bedrock-agentcore-tool-name": "robot-only-mcp-lambda___robot_stop",
                },
            },
            SimpleNamespace(client_context=None),
        )

        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            json.loads(response["body"]),
            {
                "error": "Gateway request is missing a supported tool name. candidate_locations=[]",
            },
        )

    @patch.object(robot_tool_lambda.robot_executor, "execute_action", return_value=True)
    def test_dispatches_robot_dance_one(self, execute_action):
        response = robot_tool_lambda.lambda_handler(
            {"robot_id": "robot_1"},
            _context("robot_dance_one"),
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"]), "The robot is performing dance one.")
        execute_action.assert_called_once_with("robot_1", "dance_ten")
