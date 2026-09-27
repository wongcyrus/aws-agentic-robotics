"""Structured metrics helpers for the Domain Expansion Lambda."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class Metric:
    name: str
    value: float = 1
    unit: str = "Count"


class MetricsEmitter:
    def __init__(
        self,
        *,
        namespace: str = "AwsAgenticRobotics",
        service: str = "domain-expansion",
        sink: Callable[[str], None] = print,
        clock: Callable[[], float] = time.time,
    ):
        self.namespace = namespace
        self.service = service
        self.sink = sink
        self.clock = clock

    def emit(self, metric: Metric, **dimensions: str) -> None:
        names = ["Service", *sorted(dimensions)]
        payload: dict[str, Any] = {
            "_aws": {
                "Timestamp": int(self.clock() * 1000),
                "CloudWatchMetrics": [
                    {
                        "Namespace": self.namespace,
                        "Dimensions": [names],
                        "Metrics": [{"Name": metric.name, "Unit": metric.unit}],
                    }
                ],
            },
            "Service": self.service,
            metric.name: metric.value,
            **dimensions,
        }
        self.sink(json.dumps(payload, separators=(",", ":"), sort_keys=True))
