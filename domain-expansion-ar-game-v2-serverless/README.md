# Domain Expansion V2 Serverless Backend

This backend is isolated from the V1 Domain Expansion deployment. It provides:

- Cognito-authorized REST APIs for robot actions, commentary, snapshots, and portraits.
- A WebSocket coordinator using protocol version `2.0`.
- DynamoDB-backed room state, connection state, revisions, and command idempotency.
- Deadline-based challenges and reconnect-safe room snapshots.
- A score-grace resolution phase for near-simultaneous player successes.

V2 does not implement the V1 `BroadcastChannel` cross-tab coordinator. Localhost
players and viewers connect to a locally hosted or deployed WebSocket coordinator
using the same protocol as production.

Run the backend tests from the repository root:

```bash
python3 -m venv /tmp/domain-v2-venv
/tmp/domain-v2-venv/bin/pip install -r domain-expansion-ar-game-v2-serverless/backend/requirements-dev.txt
/tmp/domain-v2-venv/bin/pytest -q domain-expansion-ar-game-v2-serverless/backend/tests
```
