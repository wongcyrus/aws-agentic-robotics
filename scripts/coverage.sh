#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="$(mktemp -d)"
MIN_COVERAGE="${COVERAGE_MIN:-80}"

trap 'rm -f "${REPORT_DIR}"/*.json; rmdir "${REPORT_DIR}"' EXIT

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_EC2_METADATA_DISABLED=true

run_coverage() {
    local name="$1"
    local directory="$2"
    shift 2

    echo "==> ${name}"
    (
        cd "${ROOT_DIR}/${directory}"
        uv run --with coverage "$@" python -m coverage erase
        uv run --with coverage "$@" python -m coverage run \
            --branch \
            --source=. \
            --omit='tests/*' \
            -m unittest discover -s tests -p 'test_*.py'
        uv run --with coverage python -m coverage report -m
        uv run --with coverage python -m coverage json \
            -o "${REPORT_DIR}/${name}.json" >/dev/null
        rm -f .coverage
    )
}

run_coverage \
    simulator \
    humanoid-robot-simulator-serverless/backend \
    --with boto3 \
    --with requests \
    --with cryptography

run_coverage \
    mcp \
    mcp_server \
    --with-requirements requirements.txt

run_coverage \
    speech \
    speech_control_agentcore/backend

python3 - "${MIN_COVERAGE}" "${REPORT_DIR}" <<'PY'
import json
import sys
from pathlib import Path

minimum = float(sys.argv[1])
report_dir = Path(sys.argv[2])
totals = {
    "covered_lines": 0,
    "num_statements": 0,
    "covered_branches": 0,
    "num_branches": 0,
}

for report_path in sorted(report_dir.glob("*.json")):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    component = report["totals"]
    for key in totals:
        totals[key] += component[key]

covered = totals["covered_lines"] + totals["covered_branches"]
opportunities = totals["num_statements"] + totals["num_branches"]
percentage = 100.0 * covered / opportunities if opportunities else 100.0
line_percentage = 100.0 * totals["covered_lines"] / totals["num_statements"]
branch_percentage = 100.0 * totals["covered_branches"] / totals["num_branches"]

print("\nCombined backend coverage")
print(f"  Lines:    {line_percentage:.1f}%")
print(f"  Branches: {branch_percentage:.1f}%")
print(f"  Combined: {percentage:.1f}% (minimum {minimum:.1f}%)")

if percentage < minimum:
    raise SystemExit(
        f"Combined coverage {percentage:.1f}% is below the {minimum:.1f}% minimum."
    )
PY
