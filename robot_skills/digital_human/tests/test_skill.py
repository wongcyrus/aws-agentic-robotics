import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "skill.py"
sys.modules.setdefault("boto3", types.SimpleNamespace(Session=MagicMock()))
sys.modules.setdefault(
    "requests_auth_aws_sigv4", types.SimpleNamespace(AWSSigV4=MagicMock())
)
spec = importlib.util.spec_from_file_location("digital_human_skill", MODULE_PATH)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class DigitalHumanSkillTests(unittest.TestCase):
    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_prefixes_agentcore_name(self, post):
        post.return_value.json.return_value = {
            "result": {"content": [{"type": "text", "text": "spoken"}]}
        }
        result = skill.call_mcp_tool(
            "https://bedrock-agentcore.example", "auth", "digital_human_speech", {"message": "hi"}
        )
        self.assertEqual(result, "spoken")
        self.assertEqual(
            post.call_args.kwargs["json"]["params"]["name"],
            "digital-human-mcp-lambda___digital_human_speech",
        )

    @patch.object(skill, "call_mcp_tool", return_value="queued")
    def test_execute_speech_builds_message_only_arguments(self, call):
        self.assertEqual(
            skill.execute_speech("url", "auth", "hello"),
            (True, "queued"),
        )
        call.assert_called_once_with(
            "url", "auth", "digital_human_speech", {"message": "hello"}
        )

    @patch.object(skill, "call_mcp_tool", return_value=None)
    def test_execute_speech_reports_failure(self, _call):
        self.assertEqual(
            skill.execute_speech("url", "auth", "hello"),
            (False, "Failed to send speech to xiaoice"),
        )

    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_handles_transport_rpc_and_empty_content(self, post):
        post.side_effect = RuntimeError("offline")
        self.assertIsNone(skill.call_mcp_tool("url", "auth", "tool", {}))

        post.side_effect = None
        post.return_value.json.return_value = {"error": {"message": "bad"}}
        self.assertIsNone(skill.call_mcp_tool("url", "auth", "tool", {}))

        post.return_value.json.return_value = {
            "result": {"content": [{"type": "image"}]}
        }
        self.assertEqual(skill.call_mcp_tool("url", "auth", "tool", {}), "")

    @patch.object(skill.requests, "post")
    def test_lambda_tool_name_is_not_prefixed(self, post):
        post.return_value.json.return_value = {"result": {"content": []}}
        skill.call_mcp_tool(
            "https://lambda.example", "auth", "digital_human_speech", {}
        )
        self.assertEqual(
            post.call_args.kwargs["json"]["params"]["name"],
            "digital_human_speech",
        )

    @patch.object(skill, "execute_speech", return_value=(True, "queued"))
    @patch("builtins.print")
    def test_main_executes_and_prints_json(self, printed, execute):
        argv = [
            "skill.py",
            "--message",
            "hello",
            "--mcp-url",
            "https://lambda.example",
            "--json",
        ]
        with patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 0)
        execute.assert_called_once()
        self.assertEqual(json.loads(printed.call_args.args[0])["response"], "queued")

    def test_main_rejects_blank_message(self):
        argv = [
            "skill.py",
            "--message",
            " ",
            "--mcp-url",
            "https://lambda.example",
        ]
        with patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
