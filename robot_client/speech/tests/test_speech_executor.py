import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))

import speech_executor


class SpeechExecutorTests(unittest.TestCase):
    def make_executor(self, settings=None):
        settings = settings or {"adb_ip": "10.0.0.2:5555", "adb_path": "/custom/adb"}
        with patch.object(speech_executor, "load_settings", return_value=settings), patch.object(
            speech_executor.SpeechExecutor, "_connect_adb_device", return_value=True
        ):
            return speech_executor.SpeechExecutor("settings.yaml")

    def test_load_settings_reads_yaml(self):
        with patch("builtins.open", mock_open(read_data="adb_ip: device:5555\n")):
            self.assertEqual(
                speech_executor.load_settings("settings.yaml"),
                {"adb_ip": "device:5555"},
            )

    def test_device_connection_matches_exact_ready_device(self):
        executor = self.make_executor()
        result = MagicMock(returncode=0, stdout="List of devices\n10.0.0.2:5555\tdevice\n")
        with patch.object(speech_executor.os.path, "exists", return_value=True), patch.object(
            speech_executor.subprocess, "run", return_value=result
        ) as run:
            self.assertTrue(executor._is_device_connected())
        self.assertEqual(run.call_args.args[0], ["/custom/adb", "devices"])

    def test_ensure_connection_reconnects_and_rechecks(self):
        executor = self.make_executor()
        with patch.object(
            executor, "_is_device_connected", side_effect=[False, True]
        ), patch.object(executor, "_connect_adb_device", return_value=True) as connect:
            self.assertTrue(executor._ensure_adb_connection())
        connect.assert_called_once()

    def test_run_adb_command_handles_timeout(self):
        executor = self.make_executor()
        with patch.object(
            speech_executor.subprocess,
            "run",
            side_effect=speech_executor.subprocess.TimeoutExpired(["adb"], 10),
        ):
            self.assertFalse(executor.open_chat())

    def test_execute_flow_calls_open_close_wait_open(self):
        executor = self.make_executor()
        executor._ensure_adb_connection = MagicMock(return_value=True)
        executor.open_chat = MagicMock(side_effect=[True, True])
        executor.close_chat = MagicMock(return_value=True)
        with patch.object(speech_executor.time, "sleep") as sleep:
            executor._execute_speech_sync("hello")
        self.assertEqual(executor.open_chat.call_count, 2)
        executor.close_chat.assert_called_once()
        sleep.assert_called_once_with(2)
        self.assertFalse(executor._is_running)

    def test_execute_flow_aborts_without_connection(self):
        executor = self.make_executor()
        executor._ensure_adb_connection = MagicMock(return_value=False)
        executor.open_chat = MagicMock()
        executor._execute_speech_sync("hello")
        executor.open_chat.assert_not_called()
        self.assertFalse(executor._is_running)

    def test_execute_speech_starts_daemon_thread(self):
        executor = self.make_executor()
        with patch.object(speech_executor.threading, "Thread") as thread:
            executor.execute_speech("hello")
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()

    def test_resolve_adb_falls_back_when_configured_path_missing(self):
        executor = self.make_executor()
        with patch.object(speech_executor.os.path, "exists", return_value=False):
            self.assertEqual(executor._resolve_adb_executable(), "adb")

    def test_device_connection_rejects_command_failure_and_exceptions(self):
        executor = self.make_executor()
        with patch.object(
            speech_executor.subprocess,
            "run",
            return_value=MagicMock(returncode=1, stdout="", stderr="failure"),
        ):
            self.assertFalse(executor._is_device_connected())
        with patch.object(
            speech_executor.subprocess, "run", side_effect=OSError("missing")
        ):
            self.assertFalse(executor._is_device_connected())

    def test_ensure_connection_rejects_missing_ip_and_failed_reconnect(self):
        executor = self.make_executor({"adb_ip": None})
        self.assertFalse(executor._ensure_adb_connection())
        executor = self.make_executor()
        with patch.object(executor, "_is_device_connected", return_value=False), patch.object(
            executor, "_connect_adb_device", return_value=False
        ):
            self.assertFalse(executor._ensure_adb_connection())

    def test_run_adb_command_reports_nonzero_and_missing_binary(self):
        executor = self.make_executor()
        with patch.object(
            speech_executor.subprocess,
            "run",
            return_value=MagicMock(returncode=1, stderr="denied"),
        ):
            self.assertFalse(executor.close_chat())
        with patch.object(
            speech_executor.subprocess, "run", side_effect=FileNotFoundError
        ):
            self.assertFalse(executor.close_chat())

    def test_execute_flow_aborts_after_open_or_close_failure(self):
        executor = self.make_executor()
        executor._ensure_adb_connection = MagicMock(return_value=True)
        executor.open_chat = MagicMock(return_value=False)
        executor.close_chat = MagicMock()
        executor._execute_speech_sync("hello")
        executor.close_chat.assert_not_called()

        executor.open_chat = MagicMock(return_value=True)
        executor.close_chat = MagicMock(return_value=False)
        executor._execute_speech_sync("hello")
        self.assertEqual(executor.open_chat.call_count, 1)

    def test_running_speech_is_skipped(self):
        executor = self.make_executor()
        executor._is_running = True
        executor._ensure_adb_connection = MagicMock()
        executor._execute_speech_sync("hello")
        executor._ensure_adb_connection.assert_not_called()

    def test_connect_adb_device_delegates_to_command_runner(self):
        executor = self.make_executor()
        executor._run_adb_command = MagicMock(return_value=True)
        self.assertTrue(executor._connect_adb_device())
        executor._run_adb_command.assert_called_once_with(
            ["connect", "10.0.0.2:5555"],
            "Connect to ADB device at 10.0.0.2:5555",
        )

    def test_ensure_connection_reports_failed_post_connect_check(self):
        executor = self.make_executor()
        with patch.object(
            executor, "_is_device_connected", side_effect=[False, False]
        ), patch.object(executor, "_connect_adb_device", return_value=True):
            self.assertFalse(executor._ensure_adb_connection())

    def test_run_adb_command_handles_generic_error(self):
        executor = self.make_executor()
        with patch.object(
            speech_executor.subprocess, "run", side_effect=RuntimeError("unexpected")
        ):
            self.assertFalse(executor.open_chat())

    def test_execute_flow_handles_second_open_failure_and_exception(self):
        executor = self.make_executor()
        executor._ensure_adb_connection = MagicMock(return_value=True)
        executor.open_chat = MagicMock(side_effect=[True, False])
        executor.close_chat = MagicMock(return_value=True)
        with patch.object(speech_executor.time, "sleep"):
            executor._execute_speech_sync("hello")
        self.assertFalse(executor._is_running)

        executor._ensure_adb_connection = MagicMock(side_effect=RuntimeError("unexpected"))
        executor._execute_speech_sync("hello")
        self.assertFalse(executor._is_running)


if __name__ == "__main__":
    unittest.main()
