import io
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

from botocore.exceptions import ClientError

sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)

from models import RobotID
from services import image_service, iot_service, polly_service, speech_service
from tools import dance_tools, digital_human_tools, image_tools, robot_tools, speech_tools
import digital_human_tool_lambda
import executors


class FakeMcp:
    def __init__(self):
        self.tools = {}

    def tool(self):
        def decorator(function):
            self.tools[function.__name__] = function
            return function

        return decorator


def client_error(code):
    return ClientError(
        {"Error": {"Code": code, "Message": code}},
        "Operation",
    )


class ToolRegistrationTests(unittest.TestCase):
    @patch.object(robot_tools.robot_executor, "execute_action", return_value=True)
    def test_all_robot_tools_dispatch_expected_actions(self, execute_action):
        mcp = FakeMcp()
        robot_tools.register_robot_tools(mcp)

        self.assertEqual(len(mcp.tools), 28)
        for tool_name, function in mcp.tools.items():
            response = function(RobotID.ROBOT_1)
            self.assertIsInstance(response, str)
            self.assertTrue(response)
            expected_action = tool_name.removeprefix("robot_")
            execute_action.assert_any_call(RobotID.ROBOT_1, expected_action)

    @patch.object(dance_tools.robot_executor, "execute_action", return_value=True)
    def test_all_dance_tools_dispatch_matching_dances(self, execute_action):
        mcp = FakeMcp()
        dance_tools.register_dance_tools(mcp)

        self.assertEqual(len(mcp.tools), 10)
        for tool_name, function in mcp.tools.items():
            self.assertIn("performing dance", function(RobotID.ROBOT_2))
            expected_action = (
                "dance_ten"
                if tool_name == "robot_dance_one"
                else tool_name.removeprefix("robot_")
            )
            execute_action.assert_any_call(RobotID.ROBOT_2, expected_action)

    @patch.object(image_tools, "execute_get_image", return_value="image")
    def test_image_tool_registration_handles_enum_and_string(self, execute_get_image):
        mcp = FakeMcp()
        image_tools.register_image_tools(mcp)

        self.assertEqual(mcp.tools["get_image"](RobotID.ROBOT_1), "image")
        self.assertEqual(mcp.tools["robot_see"]("robot_2"), "image")
        self.assertEqual(
            execute_get_image.call_args_list,
            [call("robot_1"), call("robot_2")],
        )

    @patch.object(speech_tools, "execute_robot_speak", return_value="spoken")
    def test_speech_tool_registration_handles_enum(self, execute_robot_speak):
        mcp = FakeMcp()
        speech_tools.register_speech_tools(mcp)

        self.assertEqual(
            mcp.tools["robot_speak"](RobotID.ROBOT_3, " hello ", "en"),
            "spoken",
        )
        execute_robot_speak.assert_called_once_with("robot_3", " hello ", "en")

    @patch.object(
        digital_human_tools,
        "execute_digital_human_speech",
        return_value="spoken",
    )
    def test_digital_human_tool_registration(self, execute_speech):
        mcp = FakeMcp()
        digital_human_tools.register_digital_human_tools(mcp)

        self.assertEqual(mcp.tools["digital_human_speech"]("hello", "yue"), "spoken")
        execute_speech.assert_called_once_with("hello")


class IotServiceTests(unittest.TestCase):
    def setUp(self):
        self.endpoint_patcher = patch.object(
            iot_service, "SIMULATOR_ENDPOINT", "simulator.example"
        )
        self.endpoint_patcher.start()

    def tearDown(self):
        self.endpoint_patcher.stop()

    @patch.object(iot_service.requests, "post")
    def test_send_action_and_speech_to_simulator(self, post):
        post.return_value.json.return_value = {"ok": True}

        self.assertTrue(iot_service._send_to_simulator("robot_1", action_name="wave"))
        self.assertTrue(
            iot_service._send_to_simulator(
                "robot_2",
                audio_url="https://audio",
                text="hello",
                duration=1.5,
            )
        )
        self.assertIn("/run_action/robot_1", post.call_args_list[0].args[0])
        self.assertEqual(post.call_args_list[0].kwargs["json"], {"action": "wave"})
        self.assertIn("/speech/robot_2", post.call_args_list[1].args[0])

    @patch.object(iot_service.requests, "post")
    def test_simulator_failure_and_missing_endpoint(self, post):
        post.side_effect = iot_service.requests.exceptions.Timeout()
        self.assertFalse(iot_service._send_to_simulator("robot_1", action_name="wave"))

        with patch.object(iot_service, "SIMULATOR_ENDPOINT", ""):
            self.assertFalse(
                iot_service._send_to_simulator("robot_1", action_name="wave")
            )

    @patch.object(iot_service, "_send_to_simulator")
    @patch.object(iot_service, "iot_client")
    def test_execute_single_action_and_speech(self, iot_client, send_to_simulator):
        self.assertTrue(iot_service.execute_robot_action("wave", RobotID.ROBOT_1))
        payload = json.loads(iot_client.publish.call_args.kwargs["payload"])
        self.assertEqual(payload, {"toolName": "wave"})

        self.assertTrue(
            iot_service.execute_robot_action(
                "speech",
                "robot_2",
                {"audio_url": "url", "text": "hello", "duration": 2.0},
            )
        )
        payload = json.loads(iot_client.publish.call_args.kwargs["payload"])
        self.assertEqual(payload["action"], "speech")
        send_to_simulator.assert_called_with(
            "robot_2",
            action_name=None,
            audio_url="url",
            text="hello",
            duration=2.0,
        )

    @patch.object(iot_service, "_send_to_simulator")
    @patch.object(iot_service, "iot_client")
    def test_execute_all_robots_and_publish_failure(
        self, iot_client, send_to_simulator
    ):
        self.assertTrue(iot_service.execute_robot_action("stop", "all"))
        self.assertEqual(iot_client.publish.call_count, 6)
        self.assertEqual(send_to_simulator.call_count, 6)

        iot_client.publish.side_effect = RuntimeError("publish failed")
        self.assertFalse(iot_service.execute_robot_action("stop", "robot_1"))

    @patch.object(iot_service, "iot_client")
    def test_execute_xiaoice_speech(self, iot_client):
        self.assertTrue(
            iot_service.execute_xiaoice_speech(
                "xiaoice_1",
                "hello",
                presenter_id="presenter",
                metadata={"id": "record"},
            )
        )
        payload = json.loads(iot_client.publish.call_args.kwargs["payload"])
        self.assertEqual(payload["presenterId"], "presenter")
        self.assertEqual(payload["metadata"], {"id": "record"})

        iot_client.publish.side_effect = RuntimeError("publish failed")
        self.assertFalse(iot_service.execute_xiaoice_speech("xiaoice_1", "hello"))


class ImageServiceTests(unittest.TestCase):
    @patch.object(image_service, "uuid")
    @patch.object(image_service, "datetime")
    @patch.object(image_service, "s3_client")
    def test_presigned_urls(self, s3_client, datetime_mock, uuid_mock):
        datetime_mock.now.return_value.strftime.return_value = "20260921_120000"
        uuid_mock.uuid4.return_value.hex = "12345678abcdef"
        s3_client.generate_presigned_url.side_effect = ["put-url", "get-url"]

        put_result = image_service.generate_presigned_put_url("robot_1")
        self.assertEqual(put_result["upload_url"], "put-url")
        self.assertIn("robot_1_20260921_120000_12345678.jpg", put_result["object_key"])
        self.assertEqual(
            image_service.generate_presigned_get_url("object-key"),
            "get-url",
        )

    @patch.object(image_service.time, "sleep")
    @patch.object(image_service, "s3_client")
    def test_wait_for_upload_success_timeout_and_error(self, s3_client, sleep):
        s3_client.head_object.side_effect = [client_error("404"), {}]
        self.assertTrue(
            image_service.wait_for_image_upload("key", timeout=1.0, interval=0.5)
        )
        sleep.assert_called_once_with(0.5)

        s3_client.head_object.side_effect = client_error("404")
        self.assertFalse(
            image_service.wait_for_image_upload("key", timeout=1.0, interval=0.5)
        )

        s3_client.head_object.side_effect = client_error("AccessDenied")
        with self.assertRaises(ClientError):
            image_service.wait_for_image_upload("key")

    @patch.object(image_service, "s3_client")
    def test_copy_to_latest_handles_client_error(self, s3_client):
        image_service.copy_to_latest("key", "robot_1")
        s3_client.copy_object.assert_called_once()

        s3_client.copy_object.side_effect = client_error("AccessDenied")
        image_service.copy_to_latest("key", "robot_1")


class ImageToolTests(unittest.TestCase):
    @patch.object(image_tools, "generate_presigned_get_url", return_value="read-url")
    @patch.object(image_tools, "copy_to_latest")
    @patch.object(image_tools, "wait_for_image_upload", return_value=True)
    @patch.object(
        image_tools,
        "generate_presigned_put_url",
        return_value={"upload_url": "put-url", "object_key": "object-key"},
    )
    @patch.object(image_tools, "iot_client")
    def test_execute_get_image_success(
        self,
        iot_client,
        generate_put,
        wait_for_upload,
        copy_to_latest,
        generate_get,
    ):
        result = image_tools.execute_get_image("robot_1")
        self.assertIn("image_url=read-url", result)
        iot_client.publish.assert_called_once()
        copy_to_latest.assert_called_once_with("object-key", "robot_1")

    @patch.object(image_tools, "wait_for_image_upload", return_value=False)
    @patch.object(
        image_tools,
        "generate_presigned_put_url",
        return_value={"upload_url": "put-url", "object_key": "object-key"},
    )
    @patch.object(image_tools, "iot_client")
    def test_execute_get_image_timeout(self, iot_client, generate_put, wait_for_upload):
        self.assertIn(
            "did not upload",
            image_tools.execute_get_image("robot_1"),
        )


class PollyServiceTests(unittest.TestCase):
    def test_build_object_key_is_deterministic(self):
        first = polly_service._build_object_key("hello", "EN", "mp3")
        second = polly_service._build_object_key("hello", "en", "mp3")
        self.assertEqual(first, second)
        self.assertTrue(first.endswith(".mp3"))
        self.assertTrue(
            polly_service._build_object_key("hello", "en", "ogg_vorbis").endswith(
                ".ogg"
            )
        )

    @patch.object(polly_service, "_generate_presigned_get_url", return_value="cached")
    @patch.object(polly_service, "s3_client")
    def test_synthesize_uses_cached_audio(self, s3_client, generate_url):
        s3_client.head_object.return_value = {"Metadata": {"duration": "1.25"}}

        result = polly_service.synthesize_and_upload("**hello**", "en")

        self.assertEqual(result["url"], "cached")
        self.assertEqual(result["voice_id"], "Hiujin")
        self.assertEqual(result["duration"], 1.25)

    @patch.object(polly_service, "_generate_presigned_get_url", return_value="new-url")
    @patch.object(polly_service, "MP3")
    @patch.object(polly_service, "s3_client")
    @patch.object(polly_service, "polly_client")
    def test_synthesize_uploads_new_audio(
        self, polly_client, s3_client, mp3, generate_url
    ):
        s3_client.head_object.side_effect = client_error("404")
        polly_client.synthesize_speech.return_value = {
            "AudioStream": io.BytesIO(b"audio")
        }
        mp3.return_value.info.length = 2.5

        result = polly_service.synthesize_and_upload("**hello**", "en")

        self.assertEqual(result["url"], "new-url")
        self.assertEqual(result["duration"], 2.5)
        s3_client.put_object.assert_called_once()
        self.assertEqual(
            s3_client.put_object.call_args.kwargs["Metadata"],
            {"duration": "2.500000"},
        )

    @patch.object(polly_service, "s3_client")
    def test_synthesize_stops_on_cache_error(self, s3_client):
        s3_client.head_object.side_effect = client_error("AccessDenied")
        self.assertIsNone(polly_service.synthesize_and_upload("hello"))

    @patch.object(polly_service, "s3_client")
    @patch.object(polly_service, "polly_client")
    def test_synthesize_handles_polly_and_stream_failures(
        self, polly_client, s3_client
    ):
        s3_client.head_object.side_effect = client_error("404")
        polly_client.synthesize_speech.side_effect = RuntimeError("polly failed")
        self.assertIsNone(polly_service.synthesize_and_upload("hello"))

        polly_client.synthesize_speech.side_effect = None
        polly_client.synthesize_speech.return_value = {}
        self.assertIsNone(polly_service.synthesize_and_upload("hello"))

    @patch.object(polly_service, "_generate_presigned_get_url")
    @patch.object(polly_service, "MP3", side_effect=ValueError("invalid audio"))
    @patch.object(polly_service, "s3_client")
    @patch.object(polly_service, "polly_client")
    def test_synthesize_handles_duration_upload_and_url_failures(
        self, polly_client, s3_client, mp3, generate_url
    ):
        s3_client.head_object.side_effect = client_error("404")
        polly_client.synthesize_speech.return_value = {
            "AudioStream": io.BytesIO(b"audio")
        }
        generate_url.return_value = "url"

        result = polly_service.synthesize_and_upload("hello")
        self.assertEqual(result["duration"], 0.0)

        s3_client.put_object.side_effect = RuntimeError("upload failed")
        self.assertIsNone(polly_service.synthesize_and_upload("hello"))

        s3_client.put_object.side_effect = None
        generate_url.side_effect = RuntimeError("url failed")
        self.assertIsNone(polly_service.synthesize_and_upload("hello"))


class SpeechServiceAndToolTests(unittest.TestCase):
    @patch.object(speech_service, "SPEECH_TABLE", "")
    def test_save_speech_skips_without_table(self):
        self.assertEqual(
            speech_service.save_speech_message("xiaoice_1", "hello"),
            {},
        )

    @patch.object(speech_service.uuid, "uuid4", return_value="record-id")
    @patch.object(speech_service.time, "time", return_value=100)
    @patch.object(speech_service, "dynamodb")
    @patch.object(speech_service, "SPEECH_TABLE", "speech-table")
    def test_save_speech_writes_normalized_item(
        self, dynamodb, time_mock, uuid_mock
    ):
        item = speech_service.save_speech_message(
            "xiaoice_1",
            "hello",
            presenter_id="ignored",
            session_id="session",
        )
        self.assertEqual(item["presenter_id"], "current_presenter")
        self.assertEqual(item["session_id"], "session")
        self.assertEqual(item["ttl"], 400)
        dynamodb.Table.return_value.put_item.assert_called_once_with(Item=item)

    def test_execute_robot_speak_validates_input(self):
        self.assertIn("cannot be empty", speech_tools.execute_robot_speak("robot_1", " "))
        self.assertIn(
            "unsupported language",
            speech_tools.execute_robot_speak("robot_1", "hello", "xx"),
        )

    @patch.object(speech_tools, "_publish_speech_url", return_value=True)
    @patch.object(speech_tools, "synthesize_and_upload")
    def test_execute_robot_speak_success_and_publish_failure(
        self, synthesize, publish
    ):
        synthesize.return_value = {
            "url": "audio-url",
            "duration": 1.25,
            "voice_id": "Hiujin",
        }
        result = speech_tools.execute_robot_speak("robot_1", " hello ", "yue")
        self.assertIn("is speaking", result)
        self.assertIn("duration=1.25s", result)

        publish.return_value = False
        self.assertIn(
            "failed to publish",
            speech_tools.execute_robot_speak("robot_1", "hello", "yue"),
        )

        synthesize.return_value = None
        self.assertIn(
            "Failed to synthesize",
            speech_tools.execute_robot_speak("robot_1", "hello", "yue"),
        )


class ExecutorTests(unittest.TestCase):
    @patch.object(executors, "execute_robot_action", return_value=True)
    def test_execute_action_normalizes_robot_id(self, execute_action):
        self.assertTrue(
            executors.robot_executor.execute_action(RobotID.ROBOT_1, "wave")
        )
        execute_action.assert_called_once_with("wave", "robot_1")

    @patch.object(executors, "execute_robot_action", return_value=True)
    @patch.object(executors, "synthesize_and_upload")
    def test_execute_robot_speech(self, synthesize, execute_action):
        synthesize.return_value = {
            "url": "audio-url",
            "voice_id": "Hiujin",
            "duration": 1.5,
        }
        result = executors.robot_executor.execute_robot_speech(
            RobotID.ROBOT_2, " hello "
        )
        self.assertTrue(result["success"])
        execute_action.assert_called_once_with(
            "speech",
            "robot_2",
            {"audio_url": "audio-url", "text": "hello", "duration": 1.5},
        )

        synthesize.return_value = None
        self.assertFalse(
            executors.robot_executor.execute_robot_speech("robot_1", "hello")[
                "success"
            ]
        )


class DigitalHumanTests(unittest.TestCase):
    def context(self, name):
        return SimpleNamespace(
            client_context=SimpleNamespace(
                custom={"bedrockAgentCoreToolName": name}
            )
        )

    @patch.object(
        digital_human_tool_lambda,
        "execute_digital_human_speech",
        return_value="spoken",
    )
    def test_lambda_dispatch_and_payload_shapes(self, execute_speech):
        response = digital_human_tool_lambda.lambda_handler(
            {"body": '{"message":"hello","language":"yue"}'},
            self.context("digital-human___digital_human_speech"),
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"]), "spoken")
        execute_speech.assert_called_once_with("hello", "yue")

        response = digital_human_tool_lambda.lambda_handler(
            {"body": {"message": "hello"}},
            SimpleNamespace(
                client_context=None,
                bedrockAgentCoreToolName="digital_human_speech",
            ),
        )
        self.assertEqual(response["statusCode"], 200)

    def test_lambda_rejects_invalid_requests(self):
        response = digital_human_tool_lambda.lambda_handler(
            {},
            self.context("unknown"),
        )
        self.assertEqual(response["statusCode"], 400)

        response = digital_human_tool_lambda.lambda_handler(
            {"body": "[]"},
            self.context("digital_human_speech"),
        )
        self.assertEqual(response["statusCode"], 400)

        response = digital_human_tool_lambda.lambda_handler(
            [],
            self.context("digital_human_speech"),
        )
        self.assertEqual(response["statusCode"], 400)

        response = digital_human_tool_lambda.lambda_handler({}, SimpleNamespace())
        self.assertEqual(response["statusCode"], 400)

    @patch.dict(os.environ, {"SIMULATOR_ENDPOINT": "https://simulator.example/"})
    @patch.object(digital_human_tools.requests, "post")
    @patch.object(digital_human_tools, "execute_xiaoice_speech")
    @patch.object(digital_human_tools, "save_speech_message")
    @patch("services.polly_service.synthesize_and_upload")
    def test_execute_digital_human_speech(
        self, synthesize, save_message, execute_xiaoice, post
    ):
        save_message.return_value = {"id": "record-id"}
        synthesize.return_value = {"url": "audio-url"}
        post.return_value.status_code = 200

        result = digital_human_tools.execute_digital_human_speech(
            "**hello**", "en"
        )

        self.assertEqual(result, 'Digital Human is now speaking: "hello"')
        execute_xiaoice.assert_called_once()
        post.assert_called_once_with(
            "https://simulator.example/api/digital-human/speak?session_key=mcpserver",
            json={"message": "hello", "audio_url": "audio-url"},
            timeout=3.0,
        )

    def test_execute_digital_human_speech_rejects_empty(self):
        self.assertIn(
            "cannot be empty",
            digital_human_tools.execute_digital_human_speech(" "),
        )
