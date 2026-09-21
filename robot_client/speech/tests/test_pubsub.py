import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))


class PublishPacket:
    def __init__(self, payload):
        self.topic = "speech/in"
        self.payload = payload


mqtt5 = types.SimpleNamespace(
    PublishPacket=PublishPacket,
    Client=object,
    LifecycleStoppedData=object,
    LifecycleConnectSuccessData=object,
    LifecycleConnectFailureData=object,
    SubscribePacket=MagicMock,
    Subscription=MagicMock,
    UnsubscribePacket=MagicMock,
    QoS=types.SimpleNamespace(AT_LEAST_ONCE=1),
)
sys.modules.setdefault("awscrt", types.SimpleNamespace(auth=MagicMock(), mqtt5=mqtt5))
sys.modules.setdefault("awsiot", types.SimpleNamespace(mqtt5_client_builder=MagicMock()))

pubsub = importlib.import_module("pubsub")


class SpeechPubSubTests(unittest.TestCase):
    def setUp(self):
        self.executor = MagicMock()
        self.client = pubsub.SpeechPubSubClient(
            {
                "input_topic": "speech/in",
                "input_endpoint": "iot.example",
                "input_clientId": "client",
            },
            self.executor,
        )

    def publish(self, payload):
        self.client.on_publish_received(
            types.SimpleNamespace(
                publish_packet=PublishPacket(json.dumps(payload).encode())
            )
        )

    def test_format_settings(self):
        settings = {
            "input_topic": "{robot_name}/speech",
            "input_key": "{base_path}/key.pem",
        }
        self.assertEqual(
            pubsub.format_settings(settings, "xiaoice", "/srv"),
            {"input_topic": "xiaoice/speech", "input_key": "/srv/key.pem"},
        )

    def test_dispatches_nonempty_speech(self):
        self.publish({"action": "speech", "message": "Welcome"})
        self.executor.execute_speech.assert_called_once_with("Welcome")

    def test_ignores_empty_speech_and_unknown_actions(self):
        self.publish({"action": "speech", "message": ""})
        self.publish({"action": "dance"})
        self.executor.execute_speech.assert_not_called()

    def test_invalid_json_is_ignored(self):
        self.client.on_publish_received(
            types.SimpleNamespace(publish_packet=PublishPacket(b"{"))
        )
        self.executor.execute_speech.assert_not_called()

    def test_lifecycle_futures_are_only_completed_once(self):
        first = object()
        self.client.on_lifecycle_stopped(first)
        self.client.on_lifecycle_stopped(object())
        self.assertIs(self.client.future_stopped.result(), first)

    def test_connection_success_and_failure_callbacks(self):
        connected = object()
        self.client.on_lifecycle_connection_success(connected)
        self.client.on_lifecycle_connection_success(object())
        self.assertIs(self.client.future_connection_success.result(), connected)
        self.client.on_lifecycle_connection_failure(
            types.SimpleNamespace(exception=RuntimeError("offline"))
        )

    def test_build_mqtt_client_supports_mtls_and_websocket(self):
        settings = {
            "input_topic": "speech/in",
            "input_endpoint": "iot.example",
            "input_clientId": "client",
            "input_cert": "cert",
            "input_key": "key",
            "input_ca": "ca",
            "aws_access_key_id": "AKID",
            "aws_secret_access_key": "SECRET",
        }
        client = pubsub.SpeechPubSubClient(settings, self.executor)
        builder = pubsub.mqtt5_client_builder
        builder.mtls_from_path.reset_mock()
        builder.websockets_with_default_aws_signing.reset_mock()
        pubsub.auth.AwsCredentialsProvider.new_static.reset_mock()
        client.build_mqtt_client()
        client.build_mqtt_client(use_websocket=True)
        self.assertEqual(builder.mtls_from_path.call_args.kwargs["port"], 8883)
        pubsub.auth.AwsCredentialsProvider.new_static.assert_called_once_with(
            access_key_id="AKID", secret_access_key="SECRET"
        )
        self.assertEqual(
            builder.websockets_with_default_aws_signing.call_args.kwargs["region"],
            "us-east-1",
        )

    def test_connect_falls_back_to_websocket(self):
        mtls = MagicMock()
        websocket = MagicMock()

        def build(use_websocket=False):
            if use_websocket:
                self.client.future_connection_success.set_result(
                    types.SimpleNamespace(
                        connack_packet=types.SimpleNamespace(reason_code=0)
                    )
                )
                return websocket
            return mtls

        self.client.build_mqtt_client = MagicMock(side_effect=build)
        with patch.object(pubsub, "TIMEOUT", 0):
            self.client.connect()
        websocket.start.assert_called_once()

    def test_subscribe_unsubscribe_and_stop(self):
        self.client.client = MagicMock()
        self.client.client.subscribe.return_value.result.return_value = (
            types.SimpleNamespace(reason_codes=[0])
        )
        self.client.client.unsubscribe.return_value.result.return_value = (
            types.SimpleNamespace(reason_codes=[0])
        )
        self.client.future_stopped.set_result(object())
        self.client.subscribe()
        self.client.unsubscribe()
        self.client.stop()
        self.client.client.subscribe.assert_called_once()
        self.client.client.unsubscribe.assert_called_once()
        self.client.client.stop.assert_called_once()

    def test_load_settings_success_and_failure(self):
        with patch("builtins.open", mock_open(read_data="robot_name: xiaoice\n")):
            self.assertEqual(
                pubsub.load_settings("settings.yaml"), {"robot_name": "xiaoice"}
            )
        with patch("builtins.open", side_effect=OSError("missing")), self.assertRaises(
            OSError
        ):
            pubsub.load_settings("settings.yaml")

    def test_publish_outer_error_is_contained(self):
        self.client.on_publish_received(
            types.SimpleNamespace(publish_packet=object())
        )
        self.executor.execute_speech.assert_not_called()

    def test_connect_uses_successful_mtls(self):
        mqtt_client = MagicMock()
        self.client.build_mqtt_client = MagicMock(return_value=mqtt_client)
        self.client.future_connection_success.set_result(
            types.SimpleNamespace(connack_packet=types.SimpleNamespace(reason_code=0))
        )
        self.client.connect()
        self.client.build_mqtt_client.assert_called_once_with(use_websocket=False)

    def test_unsubscribe_and_stop_contain_errors_without_client(self):
        self.client.client = MagicMock()
        self.client.client.unsubscribe.side_effect = RuntimeError("offline")
        self.client.unsubscribe()
        self.client.client = None
        with patch.object(self.client.future_stopped, "result", side_effect=TimeoutError):
            self.client.stop()

    def test_run_stops_on_user_input_and_restores_signal(self):
        self.client.connect = MagicMock()
        self.client.subscribe = MagicMock()
        self.client.unsubscribe = MagicMock()
        self.client.stop = MagicMock()
        with patch.object(pubsub.signal, "signal", return_value="old") as signal, patch(
            "builtins.input", return_value="s"
        ):
            self.client.run()
        self.assertTrue(self.client.received_all_event.is_set())
        self.assertEqual(signal.call_count, 2)
        self.client.unsubscribe.assert_called_once()

    def test_run_handles_keyboard_interrupt(self):
        self.client.connect = MagicMock()
        self.client.subscribe = MagicMock()
        self.client.unsubscribe = MagicMock()
        self.client.stop = MagicMock()
        with patch.object(pubsub.signal, "signal", return_value="old"), patch(
            "builtins.input", side_effect=KeyboardInterrupt
        ):
            self.client.run()
        self.client.stop.assert_called_once()

    def test_main_builds_executor_and_runs_client(self):
        settings = {
            "robot_name": "xiaoice",
            "base_path": "/robot",
            "input_topic": "topic",
            "aws_access_key_id": "AKID",
            "aws_secret_access_key": "SECRET",
        }
        with patch.object(pubsub, "load_settings", return_value=settings), patch.object(
            pubsub, "SpeechExecutor"
        ) as executor, patch.object(pubsub, "SpeechPubSubClient") as client:
            pubsub.main()
        client.assert_called_once_with(settings, executor.return_value)
        client.return_value.run.assert_called_once()

    def test_main_contains_settings_errors(self):
        with patch.object(pubsub, "load_settings", side_effect=OSError("missing")):
            pubsub.main()


if __name__ == "__main__":
    unittest.main()
