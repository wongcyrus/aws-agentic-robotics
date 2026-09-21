import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "skill.py"
sys.modules.setdefault("boto3", types.SimpleNamespace(Session=MagicMock()))
sys.modules.setdefault(
    "requests_auth_aws_sigv4", types.SimpleNamespace(AWSSigV4=MagicMock())
)
spec = importlib.util.spec_from_file_location("humanoid_skill", MODULE_PATH)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class HumanoidSkillTests(unittest.TestCase):
    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_prefixes_agentcore_tool_and_extracts_text(self, post):
        post.return_value.json.return_value = {
            "result": {"content": [{"type": "image"}, {"type": "text", "text": "done"}]}
        }
        result = skill.call_mcp_tool(
            "https://bedrock-agentcore.example", object(), "robot_wave", {"robot_id": "r1"}
        )
        self.assertEqual(result, "done")
        self.assertEqual(
            post.call_args.kwargs["json"]["params"]["name"],
            "robot-only-mcp-lambda___robot_wave",
        )

    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_returns_none_for_transport_or_rpc_error(self, post):
        post.side_effect = RuntimeError("offline")
        self.assertIsNone(skill.call_mcp_tool("https://lambda", None, "robot_wave", {}))
        post.side_effect = None
        post.return_value.json.return_value = {"error": {"message": "bad"}}
        self.assertIsNone(skill.call_mcp_tool("https://lambda", None, "robot_wave", {}))

    def test_validate_action_returns_fuzzy_suggestions(self):
        self.assertEqual(skill.validate_action("wave"), (True, None))
        self.assertEqual(skill.validate_action("capture_image"), (True, None))
        valid, suggestions = skill.validate_action("wav")
        self.assertFalse(valid)
        self.assertIn("wave", suggestions)

    @patch.object(skill, "call_mcp_tool", return_value="ok")
    def test_execute_action_uses_robot_prefixed_tool(self, call):
        self.assertEqual(
            skill.execute_action("url", "auth", "robot_1", "dance_one"),
            (True, "ok"),
        )
        call.assert_called_once_with(
            "url", "auth", "robot_dance_one", {"robot_id": "robot_1"}
        )

    @patch.object(skill.time, "sleep")
    @patch.object(skill, "execute_action", return_value=(True, "done"))
    def test_run_sequence_skips_blanks_reports_invalid_and_waits(self, execute, sleep):
        results = skill.run_sequence(
            "url", "auth", "robot_1", [" wave ", "", "unknown"], wait=2
        )
        self.assertEqual([result["success"] for result in results], [True, False])
        execute.assert_called_once_with("url", "auth", "robot_1", "wave")
        sleep.assert_called_once_with(2)

    @patch("builtins.print")
    def test_list_actions_outputs_valid_json(self, print_mock):
        skill.list_actions()
        output = json.loads(print_mock.call_args.args[0])
        self.assertEqual(output["total_actions"], len(skill.ALL_ACTIONS) + 1)
        self.assertIn("capture_image", output["categories"]["image"])

    @patch.object(skill, "call_mcp_tool", return_value="spoken")
    def test_execute_speech_passes_language(self, call):
        self.assertEqual(
            skill.execute_speech("url", "auth", "robot_2", "hello", "en"),
            (True, "spoken"),
        )
        call.assert_called_once_with(
            "url",
            "auth",
            "robot_speak",
            {"robot_id": "robot_2", "text": "hello", "language": "en"},
            timeout=30,
        )

    @patch.object(skill, "call_mcp_tool")
    def test_capture_image_rejects_failed_and_malformed_responses(self, call):
        call.return_value = None
        self.assertIsNone(skill.capture_image("url", "auth", "robot_1"))
        call.return_value = "Cannot read image from robot"
        self.assertIsNone(skill.capture_image("url", "auth", "robot_1"))
        call.return_value = "completed without a URL"
        self.assertIsNone(skill.capture_image("url", "auth", "robot_1"))

    @patch("builtins.open", new_callable=mock_open)
    @patch.object(skill.os, "makedirs")
    @patch.object(skill.requests, "get")
    @patch.object(
        skill, "call_mcp_tool", return_value="result image_url=https://image.example/a.jpg"
    )
    def test_capture_image_downloads_to_expected_directory(
        self, _call, get, makedirs, opened
    ):
        get.return_value.content = b"jpeg"
        with patch.object(skill.uuid, "uuid4") as uuid4:
            uuid4.return_value.hex = "12345678abcdef"
            path = skill.capture_image("url", "auth", "robot_1")
        self.assertTrue(path.endswith("captured_images/robot_1_12345678.jpg"))
        get.assert_called_once_with("https://image.example/a.jpg", timeout=30)
        makedirs.assert_called_once_with(
            skill.os.path.join(skill.os.getcwd(), "captured_images"), exist_ok=True
        )
        opened().write.assert_called_once_with(b"jpeg")

    @patch.object(skill.requests, "get", side_effect=RuntimeError("offline"))
    @patch.object(
        skill, "call_mcp_tool", return_value="image_url=https://image.example/a.jpg"
    )
    def test_capture_image_handles_download_error(self, _call, _get):
        self.assertIsNone(skill.capture_image("url", "auth", "robot_1"))

    @patch.object(skill, "capture_image", return_value="/image.jpg")
    def test_run_sequence_dispatches_capture_without_sleep(self, capture):
        results = skill.run_sequence(
            "url", "auth", "robot_1", ["capture_image"], wait=-1
        )
        self.assertEqual(
            results,
            [
                {
                    "action": "capture_image",
                    "robot_id": "robot_1",
                    "success": True,
                    "file": "/image.jpg",
                }
            ],
        )
        capture.assert_called_once_with("url", "auth", "robot_1")

    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_returns_empty_text_when_content_has_no_text(self, post):
        post.return_value.json.return_value = {
            "result": {"content": [{"type": "image", "data": "..."}]}
        }
        self.assertEqual(skill.call_mcp_tool("url", "auth", "tool", {}), "")

    @patch.object(skill, "run_sequence")
    @patch("builtins.print")
    def test_main_executes_action_and_emits_json(self, printed, run_sequence):
        run_sequence.return_value = [
            {
                "action": "wave",
                "robot_id": "robot_1",
                "success": True,
                "response": "done",
            }
        ]
        argv = [
            "skill.py",
            "--robot-id",
            "robot_1",
            "--action",
            "wave",
            "--mcp-url",
            "https://lambda.example",
            "--json",
        ]
        with patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 0)
        run_sequence.assert_called_once()
        self.assertTrue(json.loads(printed.call_args.args[0])["success"])

    @patch.object(skill, "list_actions")
    def test_main_list_actions_exits_without_aws_setup(self, list_actions):
        with patch.object(sys, "argv", ["skill.py", "--list-actions"]), self.assertRaises(
            SystemExit
        ) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 0)
        list_actions.assert_called_once()

    def test_main_rejects_missing_mcp_url(self):
        argv = ["skill.py", "--robot-id", "robot_1", "--action", "wave"]
        with patch.object(sys, "argv", argv), patch.dict(
            skill.os.environ, {"MCP_SERVER_URL": "", "McpServerUrl": ""}, clear=False
        ), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
