import queue
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))

import action_executor


class ActionExecutorTests(unittest.TestCase):
    def make_executor(self, endpoint=""):
        with patch.object(action_executor.threading, "Thread") as thread:
            executor = action_executor.ActionExecutor("robot_2", endpoint, "session")
        thread.return_value.start.assert_called_once()
        return executor

    def test_add_valid_action_and_reject_unknown(self):
        executor = self.make_executor()
        executor.add_action_to_queue("wave")
        executor.add_action_to_queue("not-real")
        status = executor.get_queue_status()
        self.assertEqual([item["name"] for item in status["queue"]], ["wave"])

    def test_stop_clears_queue_and_enqueues_stand(self):
        executor = self.make_executor()
        executor.action_queue.put({"id": "old", "name": "wave"})
        executor.stop()
        self.assertTrue(executor._immediate_stop_event.is_set())
        self.assertEqual(executor.action_queue.qsize(), 1)
        self.assertEqual(executor.action_queue.get_nowait()["name"], "stand")

    def test_remove_action_by_id_preserves_other_items(self):
        executor = self.make_executor()
        executor.action_queue.put({"id": "one", "name": "wave"})
        executor.action_queue.put({"id": "two", "name": "bow"})
        executor.remove_action_from_queue("one")
        self.assertEqual(list(executor.action_queue.queue), [{"id": "two", "name": "bow"}])

    @patch.object(action_executor.requests, "post")
    def test_send_request_builds_json_rpc_payload(self, post):
        response = post.return_value
        response.json.return_value = {"result": "ok"}
        executor = self.make_executor()
        result = executor._send_request("RunAction", ["9", "1"], "ok", "bad")
        self.assertEqual(result, {"result": "ok"})
        post.assert_called_once_with(
            "http://localhost:9030/",
            headers={"deviceid": "1732853986186"},
            json={
                "id": "1732853986186",
                "jsonrpc": "2.0",
                "method": "RunAction",
                "params": ["9", "1"],
            },
            timeout=0.5,
        )
        response.raise_for_status.assert_called_once()

    @patch.object(action_executor.requests, "post")
    def test_send_request_returns_none_on_network_error(self, post):
        post.side_effect = action_executor.requests.RequestException("offline")
        executor = self.make_executor()
        self.assertIsNone(executor._send_request("StopBusServo", None, "ok", "bad"))

    @patch.object(action_executor.requests, "post")
    def test_send_to_simulator_routes_action_and_speech(self, post):
        post.return_value.json.side_effect = [{"ok": "action"}, {"ok": "speech"}]
        executor = self.make_executor("https://sim.example")

        action_result = executor._send_to_simulator(action_name="wave")
        speech_result = executor._send_to_simulator(audio_url="https://audio", text="hello")

        self.assertEqual(action_result, {"ok": "action"})
        self.assertEqual(speech_result, {"ok": "speech"})
        self.assertEqual(
            post.call_args_list[0].args[0],
            "https://sim.example/run_action/robot_2?session_key=session",
        )
        self.assertEqual(post.call_args_list[0].kwargs["json"], {"action": "wave"})
        self.assertEqual(
            post.call_args_list[1].kwargs["json"],
            {"audio_url": "https://audio", "text": "hello"},
        )

    def test_send_to_simulator_is_disabled_without_endpoint(self):
        executor = self.make_executor()
        self.assertIsNone(executor._send_to_simulator(action_name="wave"))

    def test_execute_action_honors_immediate_stop(self):
        executor = self.make_executor()
        executor._immediate_stop_event.set()
        executor._run_action = MagicMock()
        executor._run_stop_action = MagicMock()
        executor._remove_action_by_id = MagicMock()

        executor._execute_action({"id": "one", "name": "wave"})

        executor._run_action.assert_called_once_with("wave", "9", "1")
        executor._run_stop_action.assert_called_once()
        executor._remove_action_by_id.assert_called_once_with("one")
        self.assertEqual(executor.current_action, action_executor.idle_action)

    def test_run_action_notifies_simulator_then_hardware(self):
        executor = self.make_executor()
        executor._send_to_simulator = MagicMock()
        executor._send_request = MagicMock(return_value={"ok": True})
        result = executor._run_action("wave", "9", "1")
        executor._send_to_simulator.assert_called_once_with(
            action_name="wave",
            log_success_msg="Action wave sent to simulator.",
            log_error_msg="Error sending action wave to simulator:",
        )
        executor._send_request.assert_called_once_with(
            method="RunAction",
            params=["9", "1"],
            log_success_msg="Action run_action(9, 1) successful.",
            log_error_msg="Error running action run_action(9, 1):",
        )
        self.assertEqual(result, {"ok": True})

    def test_execute_action_completes_and_resets_state(self):
        executor = self.make_executor()
        executor._run_action = MagicMock()
        executor._remove_action_by_id = MagicMock()
        with patch.object(action_executor.time, "sleep"):
            executor._execute_action({"id": "one", "name": "squat"})
        executor._run_action.assert_called_once_with("squat", "11", "1")
        executor._remove_action_by_id.assert_called_once_with("one")
        self.assertEqual(executor.current_action, action_executor.idle_action)

    def test_shutdown_sets_event_and_joins_thread(self):
        executor = self.make_executor()
        executor.consumer_thread = MagicMock()
        executor.shutdown()
        self.assertTrue(executor._stop_event.is_set())
        executor.consumer_thread.join.assert_called_once()

    @patch.object(action_executor.requests, "post")
    def test_simulator_network_error_returns_none(self, post):
        post.side_effect = action_executor.requests.RequestException("offline")
        executor = self.make_executor("https://sim.example")
        self.assertIsNone(executor._send_to_simulator(action_name="wave"))

    def test_run_stop_action_uses_stop_bus_servo_rpc(self):
        executor = self.make_executor()
        executor._send_request = MagicMock(return_value={"ok": True})
        self.assertEqual(executor._run_stop_action(), {"ok": True})
        executor._send_request.assert_called_once_with(
            method="StopBusServo",
            params=["stopAction"],
            log_success_msg="Action run_stop_action() successful.",
            log_error_msg="Error running action run_stop_action():",
        )

    def test_execute_action_logs_unexpected_action_error_and_cleans_up(self):
        executor = self.make_executor()
        executor._run_action = MagicMock(side_effect=RuntimeError("hardware"))
        executor._remove_action_by_id = MagicMock()
        executor._execute_action({"id": "one", "name": "wave"})
        executor._remove_action_by_id.assert_called_once_with("one")
        self.assertEqual(executor.current_action, action_executor.idle_action)

    def test_consumer_processes_one_item_then_stops(self):
        executor = self.make_executor()
        executor.action_queue.put({"id": "one", "name": "wave"})

        def execute(_item):
            executor._stop_event.set()

        executor._execute_action = MagicMock(side_effect=execute)
        with patch.object(action_executor.time, "sleep"):
            executor._consumer()
        executor._execute_action.assert_called_once()
        self.assertTrue(executor.is_running)

    def test_consumer_handles_immediate_stop_then_exits(self):
        executor = self.make_executor()
        executor._immediate_stop_event.set()
        executor.clear_action_queue = MagicMock()

        sleep_count = 0

        def sleep(_duration):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count == 2:
                executor._stop_event.set()

        with patch.object(action_executor.time, "sleep", side_effect=sleep):
            executor._consumer()
        executor.clear_action_queue.assert_called_once()
        self.assertFalse(executor._immediate_stop_event.is_set())


if __name__ == "__main__":
    unittest.main()
