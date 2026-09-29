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
