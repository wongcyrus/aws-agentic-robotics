import base64
import json
import os
import sys
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, call, patch

sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)

import lambda_function


def rest_event(path, method="GET", session_key="session", body=None):
    event = {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
    }
    if session_key is not None:
        event["queryStringParameters"] = {"session_key": session_key}
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def response_body(response):
    return json.loads(response["body"])


def sample_robots():
    return {
        "robot_1": {
            "robot_id": "robot_1",
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
            "color": "#fff",
            "current_action": "idle",
            "action_start_time": 0.0,
            "action_duration": 0.0,
            "is_visible": True,
            "is_animating": False,
            "movement_count": 0,
        }
    }


class PersistenceAndParsingTests(unittest.TestCase):
    @patch.object(lambda_function, "get_clean_robot_states")
    @patch.object(lambda_function, "sessions_table")
    def test_get_existing_session(self, sessions_table, get_clean):
        robots = sample_robots()
        sessions_table.get_item.return_value = {"Item": {"robots": robots}}
        get_clean.return_value = robots

        self.assertEqual(lambda_function.get_session_robots("session"), robots)
        get_clean.assert_called_once_with("session", robots)

    @patch.object(lambda_function, "save_session_robots")
    @patch.object(lambda_function, "sessions_table")
    def test_get_missing_or_failed_session_creates_defaults(
        self, sessions_table, save_session
    ):
        sessions_table.get_item.return_value = {}
        robots = lambda_function.get_session_robots("new")
        self.assertEqual(len(robots), len(lambda_function.DEFAULT_ROBOTS))
        save_session.assert_called_once_with("new", robots)

        sessions_table.get_item.side_effect = RuntimeError("dynamodb")
        robots = lambda_function.get_session_robots("failed")
        self.assertEqual(len(robots), len(lambda_function.DEFAULT_ROBOTS))

    @patch.object(lambda_function.time, "time", return_value=100)
    @patch.object(lambda_function, "sessions_table")
    def test_save_session_and_error(self, sessions_table, time_mock):
        lambda_function.save_session_robots(
            "session", {"robot": {"position": [1.23456]}}
        )
        item = sessions_table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["robots"]["robot"]["position"], [Decimal("1.2346")])
        self.assertEqual(item["created_at"], 100)

        sessions_table.put_item.side_effect = RuntimeError("write")
        lambda_function.save_session_robots("session", {})

    def test_recursive_numeric_conversions(self):
        data = {"a": [1.23456, {"b": Decimal("2.5")}], "c": "value"}
        cleaned = lambda_function.clean_floats_for_dynamodb(data)
        self.assertEqual(cleaned["a"][0], Decimal("1.2346"))
        restored = lambda_function.convert_decimals_to_floats(cleaned)
        self.assertEqual(restored["a"][1]["b"], 2.5)
        self.assertEqual(restored["c"], "value")

    def test_body_parsing_and_session_key_sources(self):
        self.assertEqual(lambda_function.get_body_from_event({}), {})
        self.assertEqual(
            lambda_function.get_body_from_event({"body": {"value": 1}}),
            {"value": 1},
        )
        encoded = base64.b64encode(b'{"value":2}').decode()
        self.assertEqual(
            lambda_function.get_body_from_event(
                {"body": encoded, "isBase64Encoded": True}
            ),
            {"value": 2},
        )
        self.assertEqual(lambda_function.get_body_from_event({"body": "bad"}), {})
        self.assertEqual(
            lambda_function.get_body_from_event(
                {"body": "not-base64", "isBase64Encoded": True}
            ),
            {},
        )

        self.assertEqual(
            lambda_function.get_session_key_from_event(
                {"queryStringParameters": {"session-key": "query"}}
            ),
            "query",
        )
        self.assertEqual(
            lambda_function.get_session_key_from_event(
                {"headers": {"X-Session-Key": "header"}}
            ),
            "header",
        )
        self.assertEqual(
            lambda_function.get_session_key_from_event(
                {"body": '{"session_key":"body"}'}
            ),
            "body",
        )
        self.assertIsNone(lambda_function.get_session_key_from_event({}))


class ConnectionTests(unittest.TestCase):
    @patch.object(lambda_function, "connections_table")
    def test_connection_storage_and_query(self, connections_table):
        lambda_function.save_connection("connection", "session")
        connections_table.put_item.assert_called_once()

        lambda_function.delete_connection("connection")
        connections_table.delete_item.assert_called_once_with(
            Key={"connection_id": "connection"}
        )

        connections_table.query.return_value = {
            "Items": [{"connection_id": "one"}, {"connection_id": "two"}]
        }
        self.assertEqual(
            lambda_function.get_session_connections("session"),
            ["one", "two"],
        )

        connections_table.query.side_effect = RuntimeError("query")
        self.assertEqual(lambda_function.get_session_connections("session"), [])

        connections_table.put_item.side_effect = RuntimeError("write")
        connections_table.delete_item.side_effect = RuntimeError("delete")
        lambda_function.save_connection("connection", "session")
        lambda_function.delete_connection("connection")

    @patch.object(lambda_function, "get_session_connections", return_value=[])
    def test_broadcast_skips_without_connections(self, get_connections):
        lambda_function.post_to_connections({}, "session", {"value": 1})

    @patch.object(lambda_function, "delete_connection")
    @patch.object(
        lambda_function, "get_session_connections", return_value=["one", "two", "three"]
    )
    @patch.object(lambda_function.boto3, "client")
    def test_broadcast_posts_and_cleans_gone_connections(
        self, boto_client, get_connections, delete_connection
    ):
        class GoneException(Exception):
            pass

        client = MagicMock()
        client.exceptions.GoneException = GoneException
        client.post_to_connection.side_effect = [
            None,
            GoneException(),
            RuntimeError("send"),
        ]
        boto_client.return_value = client
        event = {
            "requestContext": {
                "domainName": "socket.example",
                "stage": "prod",
            }
        }

        lambda_function.post_to_connections(
            event,
            "session",
            {"value": Decimal("1.5")},
        )

        boto_client.assert_called_once_with(
            "apigatewaymanagementapi",
            endpoint_url="https://socket.example/prod",
        )
        delete_connection.assert_called_once_with("two")
        self.assertIn('"value": 1.5', client.post_to_connection.call_args_list[0].kwargs["Data"])

    @patch.object(lambda_function, "get_session_connections", return_value=["one"])
    @patch.object(lambda_function.boto3, "client")
    def test_broadcast_uses_configured_websocket_endpoint(
        self, boto_client, get_connections
    ):
        with patch.dict(
            os.environ, {"WEBSOCKET_ENDPOINT": "wss://socket.example/prod"}
        ):
            lambda_function.post_to_connections({}, "session", {"value": 1})
        boto_client.assert_called_once_with(
            "apigatewaymanagementapi",
            endpoint_url="https://socket.example/prod",
        )

    @patch.object(lambda_function, "get_session_connections", return_value=["one"])
    def test_broadcast_requires_callback_endpoint(self, get_connections):
        with patch.dict(os.environ, {}, clear=True):
            lambda_function.post_to_connections({}, "session", {"value": 1})

    @patch.object(lambda_function.boto3, "client")
    def test_single_connection_callback(self, boto_client):
        client = boto_client.return_value
        event = {
            "requestContext": {
                "domainName": "socket.example",
                "stage": "prod",
            }
        }
        lambda_function.post_to_single_connection(
            event, "one", {"value": Decimal("2.5")}
        )
        self.assertIn("2.5", client.post_to_connection.call_args.kwargs["Data"])

        client.post_to_connection.side_effect = RuntimeError("send")
        lambda_function.post_to_single_connection(event, "one", {})


class RestRoutingTests(unittest.TestCase):
    def test_options_missing_session_and_unknown_endpoint(self):
        self.assertEqual(
            lambda_function.handle_rest_request(rest_event("/", "OPTIONS", None))[
                "statusCode"
            ],
            200,
        )
        self.assertEqual(
            lambda_function.handle_rest_request(rest_event("/api/robots", session_key=None))[
                "statusCode"
            ],
            400,
        )
        self.assertEqual(
            lambda_function.handle_rest_request(rest_event("/unknown"))["statusCode"],
            404,
        )

    @patch.object(lambda_function, "post_to_connections")
    @patch.object(lambda_function, "save_session_robots")
    @patch.object(lambda_function, "get_session_robots")
    def test_add_remove_and_reset_routes(
        self, get_robots, save_robots, post_connections
    ):
        robots = sample_robots()
        get_robots.return_value = robots
        added = lambda_function.handle_rest_request(
            rest_event(
                "/api/add_robot/robot_2",
                "POST",
                body={"position": [1, 2, 3], "color": "#000"},
            )
        )
        self.assertEqual(added["statusCode"], 200)
        self.assertIn("robot_2", robots)

        duplicate = lambda_function.handle_rest_request(
            rest_event("/api/add_robot/robot_2", "POST", body={})
        )
        self.assertEqual(duplicate["statusCode"], 400)

        removed = lambda_function.handle_rest_request(
            rest_event("/api/remove_robot/robot_2", "DELETE")
        )
        self.assertEqual(removed["statusCode"], 200)
        missing = lambda_function.handle_rest_request(
            rest_event("/api/remove_robot/robot_99", "DELETE")
        )
        self.assertEqual(missing["statusCode"], 404)

        remove_all = lambda_function.handle_rest_request(
            rest_event("/api/remove_robot/all", "DELETE")
        )
        self.assertEqual(remove_all["statusCode"], 200)
        self.assertEqual(robots, {})

        reset = lambda_function.handle_rest_request(
            rest_event("/api/reset_robots", "POST")
        )
        self.assertEqual(reset["statusCode"], 200)
        self.assertEqual(len(response_body(reset)["robots"]), len(lambda_function.DEFAULT_ROBOTS))

    @patch.object(lambda_function, "handle_real_robot_commands")
    @patch.object(lambda_function, "post_to_connections")
    @patch.object(lambda_function, "save_session_robots")
    @patch.object(lambda_function, "get_session_robots")
    def test_action_and_speech_routes(
        self, get_robots, save_robots, post_connections, handle_real
    ):
        robots = sample_robots()
        get_robots.return_value = robots

        missing_action = lambda_function.handle_rest_request(
            rest_event("/run_action/robot_1", "POST", body={})
        )
        self.assertEqual(missing_action["statusCode"], 400)

        unknown_robot = lambda_function.handle_rest_request(
            rest_event("/run_action/robot_2", "POST", body={"action": "wave"})
        )
        self.assertEqual(unknown_robot["statusCode"], 404)

        action = lambda_function.handle_rest_request(
            rest_event("/run_action/robot_1", "POST", body={"action": "wave"})
        )
        self.assertEqual(action["statusCode"], 200)
        self.assertEqual(robots["robot_1"]["current_action"], "wave")
        handle_real.assert_called_once()

        action_all = lambda_function.handle_rest_request(
            rest_event("/run_action/all", "POST", body={"action": "bow"})
        )
        self.assertEqual(action_all["statusCode"], 200)

        missing_audio = lambda_function.handle_rest_request(
            rest_event("/speech/robot_1", "POST", body={})
        )
        self.assertEqual(missing_audio["statusCode"], 400)
        speech = lambda_function.handle_rest_request(
            rest_event(
                "/speech/robot_1",
                "POST",
                body={"audio_url": "https://audio", "text": "hello"},
            )
        )
        self.assertEqual(speech["statusCode"], 200)

    @patch.object(lambda_function, "post_to_connections")
    def test_video_routes(self, post_connections):
        missing_source = lambda_function.handle_rest_request(
            rest_event("/api/video/change_source", "POST", body={})
        )
        self.assertEqual(missing_source["statusCode"], 400)
        changed = lambda_function.handle_rest_request(
            rest_event(
                "/api/video/change_source",
                "POST",
                body={"video_src": "video.mp4"},
            )
        )
        self.assertEqual(changed["statusCode"], 200)

        invalid = lambda_function.handle_rest_request(
            rest_event("/api/video/control", "POST", body={"action": "rewind"})
        )
        self.assertEqual(invalid["statusCode"], 400)
        valid = lambda_function.handle_rest_request(
            rest_event("/api/video/control", "POST", body={"action": "play"})
        )
        self.assertEqual(valid["statusCode"], 200)

        status = lambda_function.handle_rest_request(
            rest_event("/api/video/status")
        )
        self.assertEqual(status["statusCode"], 200)

    def test_xiaoice_validation_routes(self):
        event = rest_event("/api/xiaoice_token")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                lambda_function.handle_rest_request(event)["statusCode"],
                500,
            )

        with patch.dict(os.environ, {"XIAOICE_SUBSCRIPTION_KEY": "secret"}):
            self.assertEqual(
                lambda_function.handle_rest_request(event)["statusCode"],
                400,
            )
            event["queryStringParameters"]["project_id"] = "short"
            self.assertEqual(
                lambda_function.handle_rest_request(event)["statusCode"],
                400,
            )

    @patch.object(lambda_function.boto3, "client")
    def test_video_preload_list(self, boto_client):
        with patch.dict(os.environ, {}, clear=True):
            empty = lambda_function.handle_rest_request(
                rest_event("/api/video/preload_list")
            )
        self.assertEqual(response_body(empty)["available_videos"], [])

        boto_client.return_value.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "video/one.mp4"},
                {"Key": "video/readme.txt"},
                {"Key": "video/two.mp4"},
            ]
        }
        with patch.dict(os.environ, {"VIDEO_BUCKET_NAME": "bucket"}):
            result = lambda_function.handle_rest_request(
                rest_event("/api/video/preload_list")
            )
        self.assertEqual(
            response_body(result)["available_videos"],
            ["one.mp4", "two.mp4"],
        )


class RealRobotAndWebSocketTests(unittest.TestCase):
    @patch.object(lambda_function, "send_request")
    @patch.object(lambda_function, "decrypt")
    def test_real_robot_dispatch_authorization(self, decrypt, send_request):
        robots = {"robot_1": {}, "robot_2": {}}

        decrypt.return_value = None
        lambda_function.handle_real_robot_commands("key", robots, "wave", "all")
        send_request.assert_not_called()

        decrypt.return_value = {"is_valid": True, "robot": "all"}
        lambda_function.handle_real_robot_commands("key", robots, "wave", "all")
        self.assertEqual(send_request.call_count, 2)

        send_request.reset_mock()
        lambda_function.handle_real_robot_commands("key", robots, "wave", "robot_1")
        send_request.assert_called_once_with(
            method="RunAction", robot_id="robot_1", action="wave"
        )

        send_request.reset_mock()
        decrypt.return_value = {"is_valid": True, "robot": "robot_2"}
        lambda_function.handle_real_robot_commands("key", robots, "bow", "robot_2")
        send_request.assert_called_once()

        decrypt.side_effect = RuntimeError("decrypt")
        lambda_function.handle_real_robot_commands("key", robots, "wave", "robot_1")

    @patch.object(lambda_function, "post_to_connections")
    @patch.object(lambda_function, "post_to_single_connection")
    @patch.object(lambda_function, "save_session_robots")
    @patch.object(lambda_function, "get_session_robots")
    @patch.object(lambda_function, "save_connection")
    def test_websocket_message_routes(
        self,
        save_connection,
        get_robots,
        save_robots,
        post_single,
        post_connections,
    ):
        robots = sample_robots()
        get_robots.return_value = robots
        base = {
            "requestContext": {
                "routeKey": "$default",
                "domainName": "socket.example",
                "stage": "prod",
            }
        }

        invalid = dict(base, body="{")
        self.assertEqual(
            lambda_function.handle_websocket_event(invalid, "connection")[
                "statusCode"
            ],
            400,
        )

        missing_session = dict(base, body=json.dumps({"action": "join_session"}))
        self.assertEqual(
            lambda_function.handle_websocket_event(missing_session, "connection")[
                "body"
            ],
            "Missing Session Key",
        )

        def invoke(payload):
            event = dict(base, body=json.dumps({"session_key": "session", **payload}))
            return lambda_function.handle_websocket_event(event, "connection")

        self.assertEqual(invoke({"action": "join_session"})["body"], "States Returned")
        self.assertEqual(
            invoke(
                {
                    "action": "robot_action",
                    "robot_id": "robot_1",
                    "action_name": "wave",
                }
            )["body"],
            "Processed",
        )
        invoke({"action": "robot_action", "robot_id": "robot_99"})
        invoke({"action": "reset_session"})
        invoke({"action": "change_video_source", "video_src": "video.mp4"})
        invoke({"action": "change_video_source"})
        invoke({"action": "speech", "audio_url": "url", "text": "hello"})
        invoke({"action": "speech"})
        invoke({"action": "control_video", "action": "play"})
        invoke({"action": "control_video", "action": "rewind"})
        invoke({"action": "camera_control", "x": 1})

    def test_websocket_unknown_route_and_lambda_error(self):
        self.assertEqual(
            lambda_function.handle_websocket_event(
                {"requestContext": {"routeKey": "unknown"}},
                "connection",
            )["statusCode"],
            404,
        )
        with patch.object(
            lambda_function,
            "handle_rest_request",
            side_effect=RuntimeError("handler"),
        ):
            result = lambda_function.lambda_handler({}, None)
        self.assertEqual(result["statusCode"], 500)

