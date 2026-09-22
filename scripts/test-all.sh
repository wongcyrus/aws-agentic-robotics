#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_EC2_METADATA_DISABLED=true

echo "==> Deployment output contracts"
"${ROOT_DIR}/scripts/deployment/tests/test_deployment_output.sh"

run_pytest_coverage() {
    local name="$1"
    local directory="$2"
    local minimum="$3"

    echo "==> ${name}"
    (
        cd "${ROOT_DIR}/${directory}"
        uv run --with-requirements requirements-dev.txt pytest \
            --cov=. \
            --cov-branch \
            --cov-config="${ROOT_DIR}/.coveragerc" \
            --cov-fail-under="${minimum}" \
            --cov-report=term-missing \
            -q
        rm -f .coverage
    )
}

echo "==> Core backend coverage"
"${ROOT_DIR}/scripts/coverage.sh"

echo "==> CDK"
(
    cd "${ROOT_DIR}/cdk"
    npm test -- --runInBand --coverage
    npx tsc --noEmit
    rm -rf coverage
)

echo "==> Domain Expansion Node helpers"
(
    cd "${ROOT_DIR}/domain-expansion-ar-game"
    node --check server.js
    node --test --experimental-test-coverage \
        --test-coverage-lines=90 \
        --test-coverage-branches=90 \
        --test-coverage-functions=90
)

run_pytest_coverage "Text control" "text_control" 85
run_pytest_coverage \
    "Domain Expansion serverless backend" \
    "domain-expansion-ar-game-serverless/backend" \
    80
run_pytest_coverage \
    "Domain Expansion commentator AgentCore" \
    "domain-expansion-commentator-agentcore" \
    85

echo "==> Robot clients"
(
    cd "${ROOT_DIR}/robot_client"
    uv run --with coverage python -m coverage erase
    uv run --with coverage \
        --with-requirements humanoid/requirements.txt \
        python -m coverage run \
        --parallel-mode --source=humanoid \
        -m unittest discover -s humanoid/tests -p 'test_*.py'
    uv run --with coverage \
        --with-requirements speech/requirements.txt \
        python -m coverage run \
        --parallel-mode --source=speech \
        -m unittest discover -s speech/tests -p 'test_*.py'
    uv run --with coverage python -m coverage combine --quiet
    uv run --with coverage python -m coverage report \
        --fail-under=85 -m --omit='*/tests/*'
    rm -f .coverage .coverage.*
    rm -f speech/logs/speech.log
)

echo "==> Robot skills"
(
    cd "${ROOT_DIR}/robot_skills"
    uv run --with coverage python -m coverage erase
    uv run --with coverage \
        --with-requirements humanoid/requirements.txt \
        python -m coverage run \
        --parallel-mode --source=humanoid/scripts \
        -m unittest discover -s humanoid/tests -p 'test_*.py'
    uv run --with coverage \
        --with-requirements digital_human/requirements.txt \
        python -m coverage run \
        --parallel-mode --source=digital_human/scripts \
        -m unittest discover -s digital_human/tests -p 'test_*.py'
    uv run --with coverage \
        --with-requirements digital_human_adb/requirements.txt \
        python -m coverage run \
        --parallel-mode --source=digital_human_adb/scripts \
        -m unittest discover -s digital_human_adb/tests -p 'test_*.py'
    uv run --with coverage python -m coverage combine --quiet
    uv run --with coverage python -m coverage report \
        --fail-under=85 -m --omit='*/tests/*'
    rm -f .coverage .coverage.*
)
