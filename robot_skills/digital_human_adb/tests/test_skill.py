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
spec = importlib.util.spec_from_file_location("digital_human_adb_skill", MODULE_PATH)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class AdbExecutorTests(unittest.TestCase):
    def setUp(self):
        self.executor = skill.AdbExecutor(
            {"adb_ip": "device:5555", "adb_path": "/custom/adb", "wait_duration": 0.25}
        )

    @patch.object(skill.subprocess, "run")
    @patch.object(skill.os.path, "exists", return_value=True)
    def test_connected_device_must_be_ready(self, _exists, run):
        run.return_value = MagicMock(
            returncode=0, stdout="device:5555\tdevice\nother\toffline\n"
        )
        self.assertTrue(self.executor._is_device_connected())
        run.return_value.stdout = "device:5555\toffline\n"
        self.assertFalse(self.executor._is_device_connected())

    def test_ensure_connection_attempts_connect(self):
        with patch.object(
            self.executor, "_is_device_connected", side_effect=[False, True]
        ), patch.object(skill.subprocess, "run") as run:
            self.assertTrue(self.executor._ensure_adb_connection())
        self.assertEqual(
            run.call_args.args[0],
            ["adb", "connect", "device:5555"],
        )

    def test_execute_flow_orders_commands_and_wait(self):
        self.executor._ensure_adb_connection = MagicMock(return_value=True)
        self.executor.open_chat = MagicMock()
        self.executor.close_chat = MagicMock()
        with patch.object(skill.time, "sleep") as sleep:
            self.executor.execute_flow()
        self.assertEqual(self.executor.open_chat.call_count, 2)
        self.executor.close_chat.assert_called_once()
        sleep.assert_called_once_with(0.25)

    @patch.object(skill, "call_mcp_tool", return_value="queued")
    def test_execute_speech_runs_adb_then_mcp(self, call):
        adb = MagicMock()
        result = skill.execute_speech("url", "auth", "hello", adb)
        self.assertEqual(result, (True, "queued"))
        adb.execute_flow.assert_called_once()
        call.assert_called_once_with(
            "url", "auth", "digital_human_speech", {"message": "hello"}
        )

    def test_load_settings_returns_data_or_empty_on_failure(self):
        with patch("builtins.open", mock_open(read_data="adb_ip: device:5555\n")):
            self.assertEqual(
                skill.load_settings("settings.yaml"), {"adb_ip": "device:5555"}
            )
        with patch("builtins.open", side_effect=OSError("missing")):
            self.assertEqual(skill.load_settings("settings.yaml"), {})

    def test_missing_adb_ip_cannot_connect(self):
        executor = skill.AdbExecutor({})
        self.assertFalse(executor._is_device_connected())
        self.assertFalse(executor._ensure_adb_connection())

    @patch.object(skill.subprocess, "run")
    def test_adb_checks_and_commands_handle_errors(self, run):
        run.return_value = MagicMock(returncode=1, stdout="", stderr="denied")
        self.assertFalse(self.executor._is_device_connected())
        self.assertFalse(self.executor.open_chat())
        run.side_effect = OSError("missing")
        self.assertFalse(self.executor._is_device_connected())
        self.assertFalse(self.executor.close_chat())

    def test_execute_flow_aborts_when_connection_unavailable(self):
        self.executor._ensure_adb_connection = MagicMock(return_value=False)
        self.executor.open_chat = MagicMock()
        self.executor.execute_flow()
        self.executor.open_chat.assert_not_called()

    @patch.object(skill.requests, "post")
    def test_call_mcp_tool_handles_success_and_failures(self, post):
        post.return_value.json.return_value = {
            "result": {"content": [{"type": "text", "text": "done"}]}
        }
        self.assertEqual(
            skill.call_mcp_tool(
                "https://bedrock-agentcore.example",
                "auth",
                "digital_human_speech",
                {},
            ),
            "done",
        )
        self.assertEqual(
            post.call_args.kwargs["json"]["params"]["name"],
            "digital-human-mcp-lambda___digital_human_speech",
        )
        post.return_value.json.return_value = {"error": {"message": "bad"}}
        self.assertIsNone(skill.call_mcp_tool("url", "auth", "tool", {}))
        post.side_effect = RuntimeError("offline")
        self.assertIsNone(skill.call_mcp_tool("url", "auth", "tool", {}))

    @patch.object(skill, "call_mcp_tool", return_value=None)
    def test_execute_speech_reports_mcp_failure(self, _call):
        self.assertEqual(
            skill.execute_speech("url", "auth", "hello"),
            (False, "Failed to send speech to xiaoice"),
        )

    @patch.object(skill, "load_settings", return_value={"adb_ip": "device:5555"})
    @patch.object(skill, "execute_speech", return_value=(True, "queued"))
    @patch("builtins.print")
    def test_main_loads_adb_settings_and_prints_json(
        self, printed, execute, load_settings
    ):
        argv = [
            "skill.py",
            "--message",
            "hello",
            "--mcp-url",
            "https://lambda.example",
            "--settings",
            "settings.yaml",
            "--json",
        ]
        with patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 0)
        load_settings.assert_called_once_with("settings.yaml")
        self.assertIsInstance(execute.call_args.kwargs["adb_executor"], skill.AdbExecutor)
        self.assertEqual(json.loads(printed.call_args.args[0])["response"], "queued")

    def test_main_rejects_missing_url(self):
        with patch.object(
            sys, "argv", ["skill.py", "--message", "hello"]
        ), patch.dict(
            skill.os.environ, {"MCP_SERVER_URL": "", "McpServerUrl": ""}, clear=False
        ), self.assertRaises(SystemExit) as exit_info:
            skill.main()
        self.assertEqual(exit_info.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
