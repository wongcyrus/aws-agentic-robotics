import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))

import speech_player


class SpeechPlayerTests(unittest.TestCase):
    def setUp(self):
        speech_player.SpeechPlayer._instance = None

    def test_singleton_and_player_detection_priority(self):
        with patch.object(speech_player.shutil, "which", side_effect=lambda name: name == "ffplay"):
            first = speech_player.SpeechPlayer()
            second = speech_player.SpeechPlayer()
        self.assertIs(first, second)
        self.assertEqual(first._player, "ffplay")

    def test_play_ignores_empty_url_or_missing_player(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value=None):
            player = speech_player.SpeechPlayer()
        with patch.object(speech_player.threading, "Thread") as thread:
            player.play("")
            player.play("https://audio")
        thread.assert_not_called()

    def test_stop_terminates_running_process(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        process = MagicMock(pid=123)
        process.poll.return_value = None
        player._current_process = process
        player.stop()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)
        self.assertIsNone(player._current_process)

    @patch.object(speech_player.subprocess, "Popen")
    def test_mpv_command_is_noninteractive(self, popen):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        player._play_with_mpv("https://audio")
        self.assertEqual(
            popen.call_args.args[0],
            ["mpv", "--no-video", "--really-quiet", "--no-terminal", "https://audio"],
        )
        popen.return_value.wait.assert_called_once()

    def test_play_starts_daemon_thread_after_stopping_current_audio(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        player.stop = MagicMock()
        with patch.object(speech_player.threading, "Thread") as thread:
            player.play("https://audio", "hello")
        player.stop.assert_called_once()
        self.assertEqual(thread.call_args.kwargs["args"], ("https://audio", "hello"))
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()

    def test_stop_kills_process_when_terminate_times_out(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        process = MagicMock(pid=123)
        process.poll.return_value = None
        process.wait.side_effect = speech_player.subprocess.TimeoutExpired("mpv", 2)
        player._current_process = process
        player.stop()
        process.kill.assert_called_once()

    @patch.object(speech_player.subprocess, "Popen")
    def test_ffplay_command_is_noninteractive(self, popen):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="ffplay"):
            player = speech_player.SpeechPlayer()
        player._play_with_ffplay("https://audio")
        self.assertEqual(
            popen.call_args.args[0],
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "https://audio"],
        )

    def test_is_playing_reflects_process_state(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        self.assertFalse(player.is_playing)
        player._current_process = MagicMock()
        player._current_process.poll.return_value = None
        self.assertTrue(player.is_playing)
        player._current_process.poll.return_value = 0
        self.assertFalse(player.is_playing)

    def test_stop_contains_unexpected_process_errors(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        process = MagicMock(pid=123)
        process.poll.return_value = None
        process.terminate.side_effect = RuntimeError("process gone")
        player._current_process = process
        player.stop()
        self.assertIsNone(player._current_process)

    def test_play_thread_dispatches_aplay_and_clears_process(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="aplay"):
            player = speech_player.SpeechPlayer()
        player._current_process = MagicMock()
        player._play_with_download = MagicMock()
        player._play_thread("https://audio", "hello")
        player._play_with_download.assert_called_once_with("https://audio")
        self.assertIsNone(player._current_process)

    def test_play_thread_contains_player_errors(self):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="mpv"):
            player = speech_player.SpeechPlayer()
        player._play_with_mpv = MagicMock(side_effect=RuntimeError("audio"))
        player._play_thread("https://audio", "hello")
        self.assertIsNone(player._current_process)

    @patch.object(speech_player.os, "unlink")
    @patch.object(speech_player.os.path, "exists", return_value=True)
    @patch.object(speech_player.os, "fdopen")
    @patch.object(speech_player.tempfile, "mkstemp", return_value=(10, "audio.mp3"))
    @patch.object(speech_player.subprocess, "Popen")
    @patch.object(speech_player.subprocess, "run")
    @patch.object(speech_player.requests, "get")
    def test_aplay_download_converts_plays_and_cleans(
        self, get, run, popen, _mkstemp, fdopen, _exists, unlink
    ):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="aplay"):
            player = speech_player.SpeechPlayer()
        get.return_value.content = b"mp3"
        fdopen.return_value.__enter__.return_value = MagicMock()
        with patch.object(speech_player.shutil, "which", return_value="/usr/bin/ffmpeg"):
            player._play_with_download("https://audio")
        run.assert_called_once()
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], ["aplay", "audio.wav"])
        self.assertEqual(unlink.call_count, 2)

    @patch.object(speech_player.os.path, "exists", return_value=False)
    @patch.object(speech_player.requests, "get", side_effect=RuntimeError("offline"))
    def test_aplay_download_contains_network_error(self, _get, _exists):
        with patch.object(speech_player.SpeechPlayer, "_detect_player", return_value="aplay"):
            player = speech_player.SpeechPlayer()
        player._play_with_download("https://audio")


if __name__ == "__main__":
    unittest.main()
