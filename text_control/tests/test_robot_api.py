from services.robot_api import ActionRequest, SpeechRequest, extract_mcp_text


def test_action_request_maps_supported_operations():
    run = ActionRequest.from_payload(
        "robot_1", {"method": "RunAction", "action": "wave"}
    )
    stop = ActionRequest.from_payload(
        "", {"robot": "robot_2", "method": "StopAction"}
    )
    invalid = ActionRequest.from_payload("robot_1", {"method": "Unknown"})
    assert run.execution_actions == ["wave"]
    assert stop.execution_actions == ["stop"]
    assert stop.robot_id == "robot_2"
    assert invalid.execution_actions is None


def test_speech_request_and_mcp_text_normalization():
    request = SpeechRequest.from_payload({"text": " hello ", "language": "en"})
    assert request == SpeechRequest("hello", "en")
    assert extract_mcp_text(
        {"content": [{"type": "image"}, {"type": "text", "text": "spoken"}]}
    ) == "spoken"
    assert extract_mcp_text("fallback") == "fallback"
