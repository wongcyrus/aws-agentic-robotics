"""Structured logging and metrics helpers with conservative redaction."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

SENSITIVE_KEYS = {
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
    "x-api-key",
    "x-amz-security-token",
    "x-internal-secret",
}


def redact_mapping(values: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: "[REDACTED]" if any(marker in key.lower() for marker in SENSITIVE_KEYS) else value
        for key, value in values.items()
    }


def request_summary(request: Any) -> dict[str, Any]:
    content_type = getattr(request, "content_type", None)
    content_length = getattr(request, "content_length", None)
    return {
        "method": getattr(request, "method", "UNKNOWN"),
        "path": getattr(request, "path", "UNKNOWN"),
        "remoteIp": getattr(request, "remote_addr", None),
        "contentType": content_type,
        "contentLength": content_length,
        "queryKeys": sorted(getattr(request, "args", {}).keys()),
        "headers": redact_mapping(dict(getattr(request, "headers", {}))),
    }


@dataclass(frozen=True)
class Metric:
    name: str
    value: float = 1
    unit: str = "Count"


class MetricsEmitter:
    """Emit CloudWatch Embedded Metric Format without requiring an AWS client."""

    def __init__(
        self,
        *,
        namespace: str,
        service: str,
        sink: Callable[[str], None] = print,
        clock: Callable[[], float] = time.time,
    ):
        self.namespace = namespace
        self.service = service
        self.sink = sink
        self.clock = clock

    def emit(self, metric: Metric, **dimensions: str) -> None:
        dimension_names = ["Service", *sorted(dimensions)]
        payload: dict[str, Any] = {
            "_aws": {
                "Timestamp": int(self.clock() * 1000),
                "CloudWatchMetrics": [
                    {
                        "Namespace": self.namespace,
                        "Dimensions": [dimension_names],
                        "Metrics": [{"Name": metric.name, "Unit": metric.unit}],
                    }
                ],
            },
            "Service": self.service,
            metric.name: metric.value,
            **dimensions,
        }
        self.sink(json.dumps(payload, separators=(",", ":"), sort_keys=True))
