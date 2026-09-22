import json
from types import SimpleNamespace

from utils.observability import Metric, MetricsEmitter, redact_mapping, request_summary


def test_redaction_and_request_summary_do_not_include_secrets():
    request = SimpleNamespace(
        method="POST",
        path="/api/chat",
        remote_addr="127.0.0.1",
        content_type="application/json",
        content_length=42,
        args={"session": "secret-value"},
        headers={"Authorization": "secret", "X-Internal-Secret": "key", "Accept": "json"},
    )
    summary = request_summary(request)
    assert summary["headers"] == {
        "Authorization": "[REDACTED]",
        "X-Internal-Secret": "[REDACTED]",
        "Accept": "json",
    }
    assert summary["queryKeys"] == ["session"]
    assert "secret-value" not in json.dumps(summary)
    assert redact_mapping({"accessToken": "token", "name": "robot"}) == {
        "accessToken": "[REDACTED]",
        "name": "robot",
    }


def test_metrics_emitter_builds_emf_payload():
    output = []
    emitter = MetricsEmitter(
        namespace="Test",
        service="text-control",
        sink=output.append,
        clock=lambda: 2,
    )
    emitter.emit(Metric("AgentFailure"), route="talk")
    payload = json.loads(output[0])
    assert payload["AgentFailure"] == 1
    assert payload["Service"] == "text-control"
    assert payload["route"] == "talk"
    assert payload["_aws"]["Timestamp"] == 2000
