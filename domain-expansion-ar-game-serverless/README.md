# Domain Expansion Serverless Backend

This backend powers the primary Domain Expansion deployment. It provides:

- Cognito-authorized REST APIs for robot actions, commentary, and snapshots.
- A WebSocket coordinator using protocol version `2.0`.
- DynamoDB-backed room state, connection state, revisions, and command idempotency.
- Deadline-based challenges and reconnect-safe room snapshots.
- An authoritative preparation phase that gates the countdown on completed
  opening commentary playback from the viewer that started the match.
- A score-grace resolution phase for near-simultaneous player successes.

Battle mode does not implement the legacy `BroadcastChannel` cross-tab coordinator. Localhost
players and viewers connect to a locally hosted or deployed WebSocket coordinator
using the same protocol as production.

Commentary accepts an optional `modelId` for `strands_local`,
`agentcore_runtime`, and `local_direct`, defaulting to `moonshotai.kimi-k2.5`.
CDK sets `COMMENTARY_MODELS` from the game's `commentary-models.json` catalog
on both the Lambda and AgentCore runtime, with matching model-scoped IAM grants.
Without that environment variable, each service permits only its configured
`BEDROCK_MODEL_ID`. Unknown model IDs return HTTP 400. OpenClaw owns its model
configuration and rejects Bedrock model overrides.

GLM and DeepSeek commentary skips S3 snapshot fetching and never includes images
in inference, regardless of the requested image policy. The owned AgentCore
runtime also strips supplied images independently. Direct Bedrock, Strands Local,
and AgentCore Runtime use an explicit `COMMENTARY_MAX_TOKENS` budget (1600 in CDK).

Run the backend tests from the repository root:

```bash
python3 -m venv /tmp/domain-venv
/tmp/domain-venv/bin/pip install -r domain-expansion-ar-game-serverless/backend/requirements-dev.txt
(
  cd domain-expansion-ar-game-serverless/backend
  /tmp/domain-venv/bin/pytest -q \
    --cov=. \
    --cov-branch \
    --cov-config=../../.coveragerc \
    --cov-fail-under=80 \
    --cov-report=term-missing
)
```
