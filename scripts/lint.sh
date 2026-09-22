#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

uv lock --check --project "${ROOT_DIR}"

uv run --project "${ROOT_DIR}" --group dev ruff check \
    --select E9,F63,F7,F82 \
    --exclude '*/tests/*' \
    --exclude '*.venv/*' \
    "${ROOT_DIR}/text_control" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend" \
    "${ROOT_DIR}/domain-expansion-commentator-agentcore" \
    "${ROOT_DIR}/humanoid-robot-simulator-serverless/backend" \
    "${ROOT_DIR}/mcp_server" \
    "${ROOT_DIR}/robot_client" \
    "${ROOT_DIR}/robot_skills" \
    "${ROOT_DIR}/speech_control_agentcore/backend"

uv run --project "${ROOT_DIR}" --group dev ruff check --select I \
    "${ROOT_DIR}/text_control/services/chat_orchestration.py" \
    "${ROOT_DIR}/text_control/services/robot_api.py" \
    "${ROOT_DIR}/text_control/utils/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/http_request.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/websocket_handler.py"

uv run --project "${ROOT_DIR}" --group dev ruff format --check \
    "${ROOT_DIR}/text_control/services/chat_orchestration.py" \
    "${ROOT_DIR}/text_control/services/robot_api.py" \
    "${ROOT_DIR}/text_control/utils/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/http_request.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/websocket_handler.py"

uv run --project "${ROOT_DIR}" --group dev mypy \
    --config-file "${ROOT_DIR}/pyproject.toml" \
    "${ROOT_DIR}/text_control/services/chat_orchestration.py" \
    "${ROOT_DIR}/text_control/services/robot_api.py" \
    "${ROOT_DIR}/text_control/utils/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/http_request.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/observability.py" \
    "${ROOT_DIR}/domain-expansion-ar-game-serverless/backend/websocket_handler.py"

(
    cd "${ROOT_DIR}/cdk"
    npm run lint
    npm run typecheck
)

node --check "${ROOT_DIR}/domain-expansion-ar-game/server.js"

bash -n \
    "${ROOT_DIR}/deploy.sh" \
    "${ROOT_DIR}/load_cdkstack_env.sh" \
    "${ROOT_DIR}/scripts/deployment/validate_cdk_output.sh" \
    "${ROOT_DIR}/scripts/deployment/post_deploy_checks.sh"
