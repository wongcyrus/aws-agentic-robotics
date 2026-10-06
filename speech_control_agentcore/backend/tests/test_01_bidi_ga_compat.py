import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path


class BidiGaCompatibilityTests(unittest.TestCase):
    def test_real_strands_bidi_contract(self):
        backend_dir = Path(__file__).resolve().parents[1]
        script = textwrap.dedent(
            """
            import inspect

            from bidi_bridge import BidiBrowserBridge, convert_client_event
            from strands.bidi import BidiAgent
            from strands.bidi.models import BedrockNovaSonicModel
            from strands.bidi.types import (
                AudioDelta,
                BidiAudioDeltaEvent,
                BidiBargeInEvent,
                BidiResponseStartEvent,
                BidiResponseStopEvent,
                BidiTranscriptDeltaEvent,
            )

            model = BedrockNovaSonicModel(
                region="us-east-1",
                model_id="amazon.nova-2-5-sonic",
                voice="tiffany",
                audio={
                    "input": {"sample_rate": 16000},
                    "output": {"sample_rate": 16000},
                },
            )
            agent = BidiAgent(
                model=model,
                tools=[],
                system_prompt="Keep replies concise.",
            )

            assert model._config["model_id"] == "amazon.nova-2-5-sonic"
            assert model._config["connection"]["restart_after_s"] == 420
            assert model._audio_config == {
                "input": {
                    "sample_rate": 16000,
                    "channels": 1,
                    "format": "pcm",
                },
                "output": {
                    "sample_rate": 16000,
                    "channels": 1,
                    "format": "pcm",
                },
            }
            assert model._voice == "tiffany"
            assert agent.model is model

            audio_input = AudioDelta(
                format="pcm",
                source={"bytes": b"audio"},
            )
            assert audio_input.to_dict() == {
                "audio_delta": {
                    "format": "pcm",
                    "source": {"bytes": b"audio"},
                }
            }

            events = [
                BidiResponseStartEvent(response_id="response"),
                BidiTranscriptDeltaEvent(
                    delta="hello",
                    role="assistant",
                    content_id="transcript",
                ),
                BidiAudioDeltaEvent(
                    audio="YXVkaW8=",
                    format="pcm",
                    sample_rate=16000,
                    channels=1,
                    content_id="audio",
                ),
                BidiBargeInEvent(),
                BidiResponseStopEvent(response_id="response"),
            ]
            assert [type(event).__name__ for event in events] == [
                "BidiResponseStartEvent",
                "BidiTranscriptDeltaEvent",
                "BidiAudioDeltaEvent",
                "BidiBargeInEvent",
                "BidiResponseStopEvent",
            ]

            converted_audio = convert_client_event(
                "bidi_audio_input",
                {
                    "audio": "YXVkaW8=",
                    "format": "pcm",
                    "sample_rate": 16000,
                    "channels": 1,
                },
            )
            assert isinstance(converted_audio, AudioDelta)
            assert converted_audio.source["bytes"] == b"audio"

            bridge = BidiBrowserBridge()
            translated = [bridge.translate_output_event(event) for event in events]
            assert translated[0][1]["event"]["contentStart"]["role"] == "ASSISTANT"
            assert translated[1][1]["event"]["textOutput"]["content"] == "hello"
            assert translated[2][1]["event"]["audioOutput"]["content"] == "YXVkaW8="
            assert translated[3][1]["event"]["contentEnd"]["stopReason"] == "INTERRUPTED"
            assert translated[4] == (True, None)

            run_parameters = inspect.signature(BidiAgent.run).parameters
            assert "inputs" in run_parameters
            assert "outputs" in run_parameters
            """
        )
        environment = os.environ.copy()
        environment.update(
            {
                "AWS_ACCESS_KEY_ID": "test",
                "AWS_SECRET_ACCESS_KEY": "test",
                "AWS_SESSION_TOKEN": "test",
                "AWS_DEFAULT_REGION": "us-east-1",
                "AWS_EC2_METADATA_DISABLED": "true",
            }
        )

        subprocess.run(
            [sys.executable, "-c", script],
            cwd=backend_dir,
            env=environment,
            check=True,
        )


if __name__ == "__main__":
    unittest.main()
