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
    def __init__(self, topic="topic", payload=b"{}"):
        self.topic = topic
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


class PubSubTests(unittest.TestCase):
    def make_client(self):
        executor = MagicMock()
        with patch.object(pubsub, "SpeechPlayer") as player:
            client = pubsub.PubSubClient(
                {
                    "input_topic": "robot/in",
                    "input_endpoint": "iot.example",
                    "input_clientId": "client",
                },
                executor,
            )
        client.speech_player = player.return_value
        return client, executor

    def publish(self, client, payload):
        packet_data = types.SimpleNamespace(
            publish_packet=PublishPacket(payload=json.dumps(payload).encode())
        )
        client.on_publish_received(packet_data)

    def test_format_settings_substitutes_robot_and_base_path(self):
        settings = {
            "input_topic": "robots/{robot_name}",
            "input_cert": "{base_path}/cert",
            "unchanged": "value",
        }
        self.assertEqual(
            pubsub.format_settings(settings, "robot_3", "/opt/robot"),
            {
                "input_topic": "robots/robot_3",
                "input_cert": "/opt/robot/cert",
                "unchanged": "value",
            },
        )

    def test_speech_payload_plays_audio_and_mirrors_to_simulator(self):
        client, executor = self.make_client()
        self.publish(
            client,
            {"action": "speech", "audio_url": "https://audio", "text": "hello"},
        )
        client.speech_player.play.assert_called_once_with("https://audio", "hello")
        executor._send_to_simulator.assert_called_once_with(
            audio_url="https://audio", text="hello"
        )

    def test_action_payload_is_enqueued(self):
        client, executor = self.make_client()
        self.publish(client, {"toolName": "wave"})
        executor.add_action_to_queue.assert_called_once_with("wave")

    def test_capture_image_requires_upload_url(self):
        client, _ = self.make_client()
        client._handle_capture_image = MagicMock()
        self.publish(client, {"toolName": "capture_image"})
        client._handle_capture_image.assert_not_called()

    @patch.object(pubsub.requests, "put")
    @patch.object(pubsub.requests, "get")
    def test_capture_image_downloads_and_uploads_bytes(self, get, put):
        client, _ = self.make_client()
        get.return_value.content = b"jpeg"
        put.return_value.status_code = 200
        client._handle_capture_image("https://upload")
        get.assert_called_once_with("http://localhost:8080/?action=snapshot", timeout=10)
        put.assert_called_once_with(
            "https://upload",
            data=b"jpeg",
            headers={"Content-Type": "image/jpeg"},
            timeout=30,
        )

    def test_invalid_json_does_not_dispatch(self):
        client, executor = self.make_client()
        packet_data = types.SimpleNamespace(
            publish_packet=PublishPacket(payload=b"not-json")
        )
        client.on_publish_received(packet_data)
        executor.add_action_to_queue.assert_not_called()

    def test_lifecycle_callbacks_complete_futures_once(self):
        client, _ = self.make_client()
        stopped = object()
        connected = object()
        client.on_lifecycle_stopped(stopped)
        client.on_lifecycle_stopped(object())
        client.on_lifecycle_connection_success(connected)
        client.on_lifecycle_connection_success(object())
        self.assertIs(client.future_stopped.result(), stopped)
        self.assertIs(client.future_connection_success.result(), connected)
        client.on_lifecycle_connection_failure(
            types.SimpleNamespace(exception=RuntimeError("offline"))
        )

    def test_build_mqtt_client_supports_mtls_and_websocket(self):
        settings = {
            "input_topic": "topic",
            "input_endpoint": "iot.example",
            "input_clientId": "client",
            "input_cert": "cert",
            "input_key": "key",
            "input_ca": "ca",
            "aws_access_key_id": "AKID",
            "aws_secret_access_key": "SECRET",
            "region": "ap-southeast-1",
        }
        with patch.object(pubsub, "SpeechPlayer"):
            client = pubsub.PubSubClient(settings, MagicMock())
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
            "ap-southeast-1",
        )

    def test_connect_uses_mtls_when_successful(self):
        client, _ = self.make_client()
        mqtt_client = MagicMock()
        client.build_mqtt_client = MagicMock(return_value=mqtt_client)
        client.future_connection_success.set_result(
            types.SimpleNamespace(connack_packet=types.SimpleNamespace(reason_code=0))
        )
        client.connect()
        client.build_mqtt_client.assert_called_once_with(use_websocket=False)
        mqtt_client.start.assert_called_once()

    def test_connect_falls_back_to_websocket(self):
        client, _ = self.make_client()
        mtls = MagicMock()
        websocket = MagicMock()

        def build(use_websocket=False):
            if use_websocket:
                client.future_connection_success.set_result(
                    types.SimpleNamespace(
                        connack_packet=types.SimpleNamespace(reason_code=0)
                    )
                )
                return websocket
            return mtls

        client.build_mqtt_client = MagicMock(side_effect=build)
        with patch.object(pubsub, "TIMEOUT", 0):
            client.connect()
        self.assertEqual(
            client.build_mqtt_client.call_args_list,
            [unittest.mock.call(use_websocket=False), unittest.mock.call(use_websocket=True)],
        )
        websocket.start.assert_called_once()

    def test_subscribe_unsubscribe_and_stop(self):
        client, executor = self.make_client()
        client.client = MagicMock()
        client.client.subscribe.return_value.result.return_value = types.SimpleNamespace(
            reason_codes=[0]
        )
        client.client.unsubscribe.return_value.result.return_value = types.SimpleNamespace(
            reason_codes=[0]
        )
        client.future_stopped.set_result(object())
        client.subscribe()
        client.unsubscribe()
        client.stop()
        client.client.subscribe.assert_called_once()
        client.client.unsubscribe.assert_called_once()
        client.client.stop.assert_called_once()
        executor.stop.assert_called_once()

    @patch.object(pubsub.requests, "get")
    def test_capture_image_handles_network_error(self, get):
        client, _ = self.make_client()
        get.side_effect = pubsub.requests.RequestException("camera offline")
        client._handle_capture_image("https://upload")

    def test_load_settings_success_and_failure(self):
        with patch("builtins.open", mock_open(read_data="robot_name: robot_1\n")):
            self.assertEqual(
                pubsub.load_settings("settings.yaml"), {"robot_name": "robot_1"}
            )
        with patch("builtins.open", side_effect=OSError("missing")), self.assertRaises(
            OSError
        ):
            pubsub.load_settings("settings.yaml")

    def test_publish_outer_error_is_contained(self):
        client, executor = self.make_client()
        client.on_publish_received(types.SimpleNamespace(publish_packet=object()))
        executor.add_action_to_queue.assert_not_called()

    def test_unsubscribe_and_stop_contain_timeout_errors(self):
        client, executor = self.make_client()
        client.client = MagicMock()
        client.client.unsubscribe.side_effect = RuntimeError("offline")
        client.unsubscribe()
        with patch.object(client.future_stopped, "result", side_effect=TimeoutError):
            client.stop()
        client.client.stop.assert_called_once()
        executor.stop.assert_called_once()

    def test_run_stops_on_user_command(self):
        client, _ = self.make_client()
        client.connect = MagicMock()
        client.subscribe = MagicMock()
        client.unsubscribe = MagicMock()
        client.stop = MagicMock()
        with patch("builtins.input", return_value=" S "):
            client.run()
        self.assertTrue(client.received_all_event.is_set())
        client.unsubscribe.assert_called_once()
        client.stop.assert_called_once()

    def test_run_handles_keyboard_interrupt(self):
        client, _ = self.make_client()
        client.connect = MagicMock()
        client.subscribe = MagicMock()
        client.unsubscribe = MagicMock()
        client.stop = MagicMock()
        with patch("builtins.input", side_effect=KeyboardInterrupt):
            client.run()
        client.unsubscribe.assert_called_once()
        client.stop.assert_called_once()

    def test_main_builds_executor_and_runs_client(self):
        settings = {
            "robot_name": "robot_1",
            "base_path": "/robot",
            "input_topic": "topic",
            "aws_access_key_id": "AKID",
            "aws_secret_access_key": "SECRET",
            "simulator_endpoint": "https://sim",
            "session_key": "session",
        }
        with patch.object(pubsub, "load_settings", return_value=settings), patch.object(
            pubsub, "ActionExecutor"
        ) as executor, patch.object(pubsub, "PubSubClient") as client, patch(
            "builtins.print"
        ):
            pubsub.main()
        executor.assert_called_once_with(
            "robot_1", "https://sim", "session"
        )
        client.return_value.run.assert_called_once()

    def test_main_contains_settings_errors(self):
        with patch.object(pubsub, "load_settings", side_effect=OSError("missing")):
            pubsub.main()


if __name__ == "__main__":
    unittest.main()
