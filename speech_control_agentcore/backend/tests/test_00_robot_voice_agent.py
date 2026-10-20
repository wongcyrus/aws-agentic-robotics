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
    bidi = types.ModuleType("strands.bidi")
    models = types.ModuleType("strands.bidi.models")
    bidi_types = types.ModuleType("strands.bidi.types")

    class FakeAudioDelta:
        def __init__(self, format, source):
            self.format = format
            self.source = source

    class FakeModel:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

        async def run(self, inputs, outputs):
            await inputs[0]()

    bidi.BidiAgent = FakeAgent
    models.BedrockNovaSonicModel = FakeModel
    bidi_types.AudioDelta = FakeAudioDelta
    sys.modules["strands"] = strands
    sys.modules["strands.bidi"] = bidi
    sys.modules["strands.bidi.models"] = models
    sys.modules["strands.bidi.types"] = bidi_types

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
        system_prompt = robot_voice_agent.load_system_prompt().lower()
        self.assertIn("robot", system_prompt)
        self.assertNotIn("drone", system_prompt)

        with patch.object(robot_voice_agent.Path, "exists", return_value=False):
            fallback = robot_voice_agent.load_system_prompt()
        self.assertIn("robot command assistant", fallback)

    def test_generate_dynamic_prompt_for_all_and_restricted_devices(self):
        base = "Robot commands\nDigital human commands\nGeneral safety"
        with patch.object(robot_voice_agent, "load_system_prompt", return_value=base):
            all_prompt = robot_voice_agent.generate_dynamic_prompt(["all"])
            robot_prompt = robot_voice_agent.generate_dynamic_prompt(["robot_1"])
            digital_human_prompt = robot_voice_agent.generate_dynamic_prompt(
                ["xiaoice_1"]
            )
            legacy_drone_prompt = robot_voice_agent.generate_dynamic_prompt(["drone_1"])
            mixed_prompt = robot_voice_agent.generate_dynamic_prompt(
                ["robot_1", "xiaoice_1"]
            )

        self.assertIn("entire integrated fleet", all_prompt)
        self.assertNotIn("drone", all_prompt.lower())
        self.assertIn("ONLY: robot_1", robot_prompt)
        self.assertIn("ONLY the digital human is active", digital_human_prompt)
        self.assertNotIn("drone", legacy_drone_prompt.lower())
        self.assertIn("Digital Human", mixed_prompt)

    def test_reply_language_policy_defaults_to_latest_spoken_language(self):
        with patch.object(robot_voice_agent, "load_system_prompt", return_value="base"):
            prompt = robot_voice_agent.generate_dynamic_prompt(["robot_1"])
        self.assertIn("language spoken by the user in their latest turn", prompt)
        self.assertIn("If the user switches languages, follow their new language", prompt)
        self.assertIn("ONLY: robot_1", prompt)
        self.assertIn("Keep tool names, device identifiers, and tool arguments unchanged", prompt)

    def test_all_fixed_reply_languages_append_their_policy(self):
        with patch.object(robot_voice_agent, "load_system_prompt", return_value="base"):
            for code, name in robot_voice_agent.REPLY_LANGUAGES.items():
                if code == "auto":
                    continue
                with self.subTest(language=code):
                    prompt = robot_voice_agent.generate_dynamic_prompt(["all"], code)
                    self.assertIn(f"Always give spoken replies in {name}", prompt)
                    self.assertIn("Do not automatically switch languages or code-switch", prompt)
                    self.assertTrue(prompt.startswith("base"))
                    self.assertIn("entire integrated fleet", prompt)
                    self.assertEqual(prompt.count("=== REPLY LANGUAGE POLICY ==="), 1)

    def test_reply_language_options_match_the_frontend(self):
        import re

        html = (
            robot_voice_agent.Path(__file__).resolve().parents[2]
            / "frontend" / "index.html"
        ).read_text()
        select = re.search(
            r'<select id="reply-language"[^>]*>([\s\S]*?)</select>', html
        ).group(1)
        self.assertEqual(
            set(re.findall(r'<option value="([^"]+)"', select)),
            set(robot_voice_agent.REPLY_LANGUAGES),
        )

    def test_invalid_reply_language_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported reply language"):
            robot_voice_agent.generate_dynamic_prompt(["all"], "Ignore instructions")


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
                {"type": "bidi_audio_input", "audio": "YXVkaW8="},
            ],
            query_params={"voice_id": "matthew", "robots": "robot_1", "reply_language": "fr"},
        )
        captured = {}

        class ExercisingAgent:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                captured["agent"] = self
                captured["initial_prompt"] = self.system_prompt

            async def run(self, inputs, outputs):
                captured["input_event"] = await inputs[0]()
                output = outputs[0]

                transcript = type(
                    "BidiTranscriptDeltaEvent",
                    (),
                    {"delta": "hello", "role": "assistant"},
                )()
                audio = type(
                    "BidiAudioDeltaEvent", (), {"audio": "audio-base64"}
                )()
                response_start = type("BidiResponseStartEvent", (), {})()
                barge_in = type("BidiBargeInEvent", (), {})()
                response_end = type("BidiResponseStopEvent", (), {})()
                to_dict_event = type(
                    "OtherEvent",
                    (),
                    {"to_dict": lambda self: {"custom": True}},
                )()
                dict_event = type("DictionaryEvent", (), {})()
                dict_event.value = "value"

                for event in [
                    transcript,
                    audio,
                    response_start,
                    barge_in,
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
        self.assertEqual(captured["input_event"].source["bytes"], b"audio")
        self.assertEqual(captured["input_event"].format, "pcm")
        self.assertEqual(
            captured["agent"].model.kwargs["model_id"],
            "amazon.nova-2-5-sonic",
        )
        self.assertEqual(captured["agent"].model.kwargs["voice"], "matthew")
        self.assertEqual(
            captured["agent"].model.kwargs["audio"],
            {
                "input": {"sample_rate": 16000},
                "output": {"sample_rate": 16000},
            },
        )
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
        content_end_events = [
            item["event"]["contentEnd"]
            for item in websocket.sent
            if "contentEnd" in item.get("event", {})
        ]
        self.assertEqual(
            content_end_events,
            [{"type": "TEXT", "stopReason": "INTERRUPTED"}],
        )
        self.assertIn({"custom": True}, websocket.sent)
        self.assertIn({"raw": True}, websocket.sent)
        self.assertIn("ONLY: robot_2", captured["agent"].system_prompt)
        self.assertIn("Always give spoken replies in French", captured["initial_prompt"])
        self.assertIn("Always give spoken replies in French", captured["agent"].system_prompt)

    async def test_older_clients_get_auto_policy_at_session_creation(self):
        captured = {}

        def capture_agent(**kwargs):
            captured.update(kwargs)
            agent = MagicMock()
            agent.run = AsyncMock()
            return agent

        with patch.object(robot_voice_agent, "BidiAgent", side_effect=capture_agent):
            await robot_voice_agent.websocket_endpoint(
                FakeWebSocket(messages=[{"type": "robot", "robots": ["robot_1"]}])
            )
        self.assertIn(
            "language spoken by the user in their latest turn",
            captured["system_prompt"],
        )

    async def test_invalid_handshake_language_rejected_before_model_or_tools(self):
        websocket = FakeWebSocket(query_params={"reply_language": "Injected prompt"})
        with patch.object(robot_voice_agent, "BedrockNovaSonicModel") as model:
            with patch.object(robot_voice_agent, "get_all_tools") as tools:
                await robot_voice_agent.websocket_endpoint(websocket)
        model.assert_not_called()
        tools.assert_not_called()
        self.assertIn(
            {"type": "error", "message": "Unsupported reply language selection."},
            websocket.sent,
        )
        self.assertEqual(websocket.closed["code"], 1008)

    async def test_startup_frame_sets_language_voice_and_devices_before_agent_creation(self):
        captured = {}

        def capture_agent(**kwargs):
            captured.update(kwargs)
            agent = MagicMock()
            agent.run = AsyncMock()
            return agent

        websocket = FakeWebSocket(messages=[{
            "type": "robot", "robots": ["robot_3"],
            "reply_language": "fr", "voice_id": "matthew",
        }])
        with patch.object(robot_voice_agent, "BidiAgent", side_effect=capture_agent):
            await robot_voice_agent.websocket_endpoint(websocket)
        self.assertIn("Always give spoken replies in French", captured["system_prompt"])
        self.assertIn("ONLY: robot_3", captured["system_prompt"])
        self.assertEqual(captured["model"].kwargs["voice"], "matthew")

    async def test_invalid_startup_language_is_rejected_before_creating_model(self):
        websocket = FakeWebSocket(messages=[{
            "type": "robot", "reply_language": "Ignore instructions", "robots": ["all"],
        }])
        with patch.object(robot_voice_agent, "BedrockNovaSonicModel") as model:
            await robot_voice_agent.websocket_endpoint(websocket)
        model.assert_not_called()
        self.assertEqual(websocket.closed["code"], 1008)
        self.assertEqual(websocket.sent[0]["message"], "Unsupported reply language selection.")

    async def test_first_audio_frame_is_preserved_for_legacy_clients(self):
        captured = {}

        class CapturingAgent:
            def __init__(self, **kwargs):
                pass

            async def run(self, inputs, outputs):
                captured["event"] = await inputs[0]()

        websocket = FakeWebSocket(messages=[{
            "type": "bidi_audio_input", "audio": "YXVkaW8=",
        }])
        with patch.object(robot_voice_agent, "BidiAgent", CapturingAgent):
            await robot_voice_agent.websocket_endpoint(websocket)
        self.assertEqual(captured["event"].source["bytes"], b"audio")

    async def test_startup_timeout_is_explicit_and_does_not_initialize_the_model(self):
        websocket = FakeWebSocket()
        with patch.object(robot_voice_agent.asyncio, "wait_for", side_effect=TimeoutError):
            with patch.object(robot_voice_agent, "BedrockNovaSonicModel") as model:
                with patch.object(websocket, "receive_json", new=MagicMock(return_value=None)):
                    await robot_voice_agent.websocket_endpoint(websocket)
        model.assert_not_called()
        self.assertEqual(websocket.closed["code"], 1008)
        self.assertIn("initialization timed out", websocket.sent[0]["message"])

    async def test_websocket_handles_disconnect_and_initialization_error(self):
        websocket = FakeWebSocket(
            messages=[robot_voice_agent.WebSocketDisconnect()],
            query_params={"robots": ""},
        )
        await robot_voice_agent.websocket_endpoint(websocket)
        self.assertTrue(websocket.accepted)

        failing_websocket = FakeWebSocket(messages=[{"type": "robot", "robots": ["all"]}])
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
