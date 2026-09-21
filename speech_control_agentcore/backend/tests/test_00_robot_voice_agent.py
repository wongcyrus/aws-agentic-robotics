import asyncio
import importlib
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch


def install_dependency_stubs():
    fastapi = types.ModuleType("fastapi")
    responses = types.ModuleType("fastapi.responses")
    staticfiles = types.ModuleType("fastapi.staticfiles")

    class FakeFastAPI:
        def __init__(self, *args, **kwargs):
            self.routes = {}

        def _decorator(self, method, path):
            def decorator(function):
                self.routes[(method, path)] = function
                return function

            return decorator

        def get(self, path):
            return self._decorator("GET", path)

        def post(self, path):
            return self._decorator("POST", path)

        def websocket(self, path):
            return self._decorator("WS", path)

        def mount(self, *args, **kwargs):
            return None

    class FakeWebSocket:
        pass

    class FakeWebSocketDisconnect(Exception):
        pass

    class FakeJSONResponse:
        def __init__(self, content=None, status_code=200):
            self.content = content
            self.status_code = status_code

    class FakeFileResponse:
        def __init__(self, path):
            self.path = path

    class FakeStaticFiles:
        def __init__(self, *args, **kwargs):
            pass

    fastapi.FastAPI = FakeFastAPI
    fastapi.WebSocket = FakeWebSocket
    fastapi.WebSocketDisconnect = FakeWebSocketDisconnect
    responses.JSONResponse = FakeJSONResponse
    responses.FileResponse = FakeFileResponse
    staticfiles.StaticFiles = FakeStaticFiles
    sys.modules["fastapi"] = fastapi
    sys.modules["fastapi.responses"] = responses
    sys.modules["fastapi.staticfiles"] = staticfiles

    strands = types.ModuleType("strands")
    experimental = types.ModuleType("strands.experimental")
    bidi = types.ModuleType("strands.experimental.bidi")
    models = types.ModuleType("strands.experimental.bidi.models")
    bidi_types = types.ModuleType("strands.experimental.bidi.types")
    events = types.ModuleType("strands.experimental.bidi.types.events")

    class FakeInputEvent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class FakeModel:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

        async def run(self, inputs, outputs):
            await inputs[0]()

    bidi.BidiAgent = FakeAgent
    models.BidiNovaSonicModel = FakeModel
    events.BidiAudioInputEvent = FakeInputEvent
    events.BidiTextInputEvent = FakeInputEvent
    events.BidiImageInputEvent = FakeInputEvent
    sys.modules["strands"] = strands
    sys.modules["strands.experimental"] = experimental
    sys.modules["strands.experimental.bidi"] = bidi
    sys.modules["strands.experimental.bidi.models"] = models
    sys.modules["strands.experimental.bidi.types"] = bidi_types
    sys.modules["strands.experimental.bidi.types.events"] = events

    tools = types.ModuleType("tools")
    tools.cleanup_tools = MagicMock()
    tools.get_all_tools = MagicMock(return_value=["tool"])
    tools.warmup_tools = MagicMock(return_value=["tool"])
    sys.modules["tools"] = tools

    boto3 = types.ModuleType("boto3")
    boto3.client = MagicMock()
    sys.modules["boto3"] = boto3

    uvicorn = types.ModuleType("uvicorn")
    uvicorn.run = MagicMock()
    sys.modules["uvicorn"] = uvicorn


install_dependency_stubs()
robot_voice_agent = importlib.import_module("robot_voice_agent")


class FakeWebSocket:
    def __init__(self, messages=None, query_params=None):
        self.messages = list(messages or [])
        self.query_params = query_params or {}
        self.sent = []
        self.accepted = False
        self.closed = None

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self.messages:
            raise robot_voice_agent.WebSocketDisconnect()
        item = self.messages.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, **kwargs):
        self.closed = kwargs


class EndpointAndPromptTests(unittest.TestCase):
    def test_endpoint_filter(self):
        filter_instance = robot_voice_agent.EndpointFilter()
        health_record = SimpleNamespace(args=("GET", "HTTP", "/ping"))
        root_record = SimpleNamespace(args=("GET", "HTTP", "/"))
        other_record = SimpleNamespace(args=("GET", "HTTP", "/ws"))
        no_args_record = SimpleNamespace(args=())

        self.assertFalse(filter_instance.filter(health_record))
        self.assertFalse(filter_instance.filter(root_record))
        self.assertTrue(filter_instance.filter(other_record))
        self.assertTrue(filter_instance.filter(no_args_record))

    def test_load_system_prompt_file_and_fallback(self):
        self.assertIn("robot", robot_voice_agent.load_system_prompt().lower())

        with patch.object(robot_voice_agent.Path, "exists", return_value=False):
            fallback = robot_voice_agent.load_system_prompt()
        self.assertIn("robot command assistant", fallback)

    def test_generate_dynamic_prompt_for_all_and_restricted_devices(self):
        base = "Robot commands\nDrone commands\nGeneral safety"
        with patch.object(robot_voice_agent, "load_system_prompt", return_value=base):
            all_prompt = robot_voice_agent.generate_dynamic_prompt(["all"])
            robot_prompt = robot_voice_agent.generate_dynamic_prompt(["robot_1"])
            drone_prompt = robot_voice_agent.generate_dynamic_prompt(["drone_1"])
            mixed_prompt = robot_voice_agent.generate_dynamic_prompt(
                ["robot_1", "drone_1", "xiaoice_1"]
            )

        self.assertIn("entire integrated fleet", all_prompt)
        self.assertNotIn("Drone commands", robot_prompt)
        self.assertIn("ONLY: robot_1", robot_prompt)
        self.assertIn("ONLY drones are active", drone_prompt)
        self.assertIn("Digital Human", mixed_prompt)


class LifecycleAndRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_warms_and_cleans_tools(self):
        with patch.object(
            robot_voice_agent, "warmup_tools", return_value=["one", "two"]
        ) as warmup:
            with patch.object(robot_voice_agent, "cleanup_tools") as cleanup:
                async with robot_voice_agent.lifespan(robot_voice_agent.app):
                    warmup.assert_called_once_with()
                cleanup.assert_called_once_with()

        with patch.object(
            robot_voice_agent,
            "warmup_tools",
            side_effect=RuntimeError("offline"),
        ):
            with patch.object(robot_voice_agent, "cleanup_tools") as cleanup:
                async with robot_voice_agent.lifespan(robot_voice_agent.app):
                    pass
                cleanup.assert_called_once_with()

    async def test_health_and_auth_config(self):
        health = await robot_voice_agent.health_check()
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.content["status"], "healthy")

        with patch.dict(
            os.environ,
            {
                "CognitoUserPoolId": "pool",
                "CognitoUserPoolClientId": "client",
            },
        ):
            config = await robot_voice_agent.get_auth_config()
        self.assertEqual(config.content["userPoolId"], "pool")
        self.assertEqual(config.content["clientId"], "client")

    async def test_login_validation_success_failure_and_exception(self):
        missing = await robot_voice_agent.login({})
        self.assertEqual(missing.status_code, 400)

        client = MagicMock()
        client.initiate_auth.return_value = {
            "AuthenticationResult": {
                "AccessToken": "access",
                "IdToken": "id",
                "RefreshToken": "refresh",
            }
        }
        with patch.object(robot_voice_agent.boto3, "client", return_value=client):
            success = await robot_voice_agent.login(
                {"username": "user", "password": "password"}
            )
        self.assertEqual(success.content["accessToken"], "access")

        client.initiate_auth.return_value = {}
        with patch.object(robot_voice_agent.boto3, "client", return_value=client):
            denied = await robot_voice_agent.login(
                {"username": "user", "password": "password"}
            )
        self.assertEqual(denied.status_code, 401)

        with patch.object(
            robot_voice_agent.boto3,
            "client",
            side_effect=RuntimeError("cognito unavailable"),
        ):
            failed = await robot_voice_agent.login(
                {"username": "user", "password": "password"}
            )
        self.assertEqual(failed.status_code, 401)
        self.assertIn("cognito unavailable", failed.content["message"])

    async def test_static_file_routes(self):
        responses = [
            await robot_voice_agent.serve_login(),
            await robot_voice_agent.serve_favicon(),
            await robot_voice_agent.serve_index(),
            await robot_voice_agent.serve_background(),
        ]
        names = [response.path.name for response in responses]
        self.assertEqual(
            names,
            ["login.html", "favicon.ico", "index.html", "background_hk.jpg"],
        )


class WebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_converts_inputs_and_serializes_outputs(self):
        websocket = FakeWebSocket(
            messages=[
                {"type": "robot", "robots": "robot_2"},
                {"type": "audioStart"},
                {"type": "stopAudio"},
                {"type": "bidi_audio_input", "audio": "encoded"},
            ],
            query_params={"voice_id": "matthew", "robots": "robot_1"},
        )
        captured = {}

        class ExercisingAgent:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                captured["agent"] = self

            async def run(self, inputs, outputs):
                captured["input_event"] = await inputs[0]()
                output = outputs[0]

                transcript = type(
                    "BidiTranscriptStreamEvent",
                    (),
                    {"text": "hello", "role": "assistant"},
                )()
                transcript_delta = type(
                    "BidiTranscriptStreamEvent",
                    (),
                    {"text": "", "delta": SimpleNamespace(text="delta")},
                )()
                audio = type(
                    "BidiAudioStreamEvent", (), {"audio": "audio-base64"}
                )()
                response_start = type("BidiResponseStartEvent", (), {})()
                response_end = type("ResponseCompleteEvent", (), {})()
                to_dict_event = type(
                    "OtherEvent",
                    (),
                    {"to_dict": lambda self: {"custom": True}},
                )()
                dict_event = type("DictionaryEvent", (), {})()
                dict_event.value = "value"

                for event in [
                    transcript,
                    transcript_delta,
                    audio,
                    response_start,
                    response_end,
                    to_dict_event,
                    dict_event,
                    {"raw": True},
                ]:
                    await output(event)

        with patch.object(robot_voice_agent, "BidiAgent", ExercisingAgent):
            with patch.object(
                robot_voice_agent, "get_all_tools", return_value=["tool"]
            ):
                await robot_voice_agent.websocket_endpoint(websocket)

        self.assertTrue(websocket.accepted)
        self.assertEqual(captured["input_event"].audio, "encoded")
        self.assertIn(
            {"type": "robot_received", "robots": ["robot_2"]},
            websocket.sent,
        )
        self.assertTrue(
            any("textOutput" in item.get("event", {}) for item in websocket.sent)
        )
        self.assertTrue(
            any("audioOutput" in item.get("event", {}) for item in websocket.sent)
        )
        self.assertIn({"custom": True}, websocket.sent)
        self.assertIn({"raw": True}, websocket.sent)
        self.assertIn("ONLY: robot_2", captured["agent"].system_prompt)

    async def test_websocket_handles_disconnect_and_initialization_error(self):
        websocket = FakeWebSocket(
            messages=[robot_voice_agent.WebSocketDisconnect()],
            query_params={"robots": ""},
        )
        await robot_voice_agent.websocket_endpoint(websocket)
        self.assertTrue(websocket.accepted)

        failing_websocket = FakeWebSocket()
        with patch.object(
            robot_voice_agent,
            "get_all_tools",
            side_effect=RuntimeError("tools unavailable"),
        ):
            await robot_voice_agent.websocket_endpoint(failing_websocket)

        self.assertIn(
            {"type": "error", "message": "tools unavailable"},
            failing_websocket.sent,
        )
        self.assertEqual(failing_websocket.closed["code"], 1011)

