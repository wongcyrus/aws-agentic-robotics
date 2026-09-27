import json

from observability import Metric, MetricsEmitter


def test_metrics_emitter_builds_deterministic_emf_payload():
    output = []
    emitter = MetricsEmitter(sink=output.append, clock=lambda: 3)
    emitter.emit(Metric("GatewayFailure"), tool="robot_wave")
    payload = json.loads(output[0])
    assert payload["GatewayFailure"] == 1
    assert payload["Service"] == "domain-expansion"
    assert payload["tool"] == "robot_wave"
    assert payload["_aws"]["Timestamp"] == 3000
