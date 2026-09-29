# Playwright gameplay E2E

The suite opens Viewer, Player 1, and Player 2 in isolated Chromium contexts.
It runs the production React applications and `WebSocketControlTransport`.
MediaPipe, camera/media devices, VFX, WebRTC, robot, and commentary boundaries
are deterministic browser mocks. Gesture frames enter through the mocked
MediaPipe `Hands.onResults` callback, then use the production
`StableGestureRecognizer` and `PlayerApp` scoring effects.

## Local

```sh
npx playwright install chromium
npm run test:e2e:local
```

Playwright starts `dev-server.mjs` with `E2E_TEST_MODE=1`. This only makes the
development server's gesture shuffle deterministic; normal development and
production builds are unchanged.

The repository-wide `scripts/test-all.sh` also runs this local browser suite.
CI installs Chromium and its Linux dependencies before running the script.

## Deployed AWS

Use an isolated test room and a temporary Cognito ID token:

```sh
E2E_MODE=aws \
PLAYWRIGHT_BASE_URL=https://frontend.example \
PLAYWRIGHT_WS_URL=wss://control.example/control \
PLAYWRIGHT_API_BASE_URL=https://api.example \
PLAYWRIGHT_COGNITO_ID_TOKEN='temporary-id-token' \
PLAYWRIGHT_COGNITO_TOKEN_EXPIRY='unix-seconds' \
PLAYWRIGHT_ROOM_PREFIX='CI42' \
npm run test:e2e:aws
```

`PLAYWRIGHT_API_BASE_URL` is optional. The token is injected into browser
storage and never written to source or reports. Use a short-lived dedicated
test identity and an isolated room-capable deployment. The suite does not create
Cognito users. Browser-side landmark fixtures cover every production gesture,
so deployed AWS challenge ordering does not need to be changed.

`PLAYWRIGHT_ROOM_PREFIX` is optional and defaults to `E2E`. It is uppercased,
non-alphanumeric characters are removed, and the result is limited to six
characters. Each room appends a two-character scenario code and a four-character
base-36 timestamp suffix, keeping the room at or below 12 characters while
allowing cleanup jobs to select only rooms from one run.

## Deployed AWS commentary

Trigger the real deployed Strands Local, AgentCore Runtime, and OpenClaw engines
through the authenticated REST API:

```sh
COMMENTARY_BASE_URL=https://frontend.example \
npm run test:commentary:aws
```

The test runs each engine sequentially, requires HTTP 200 and non-empty
commentary, verifies the reported engine, and prints response latency. It does
not attach webcam images or request Polly audio. Using the standard AWS SDK
credential chain, it reads Cognito IDs from the deployed `config.json`, creates
a temporary verified user, authenticates for an ID token, and deletes the user
in cleanup. The caller therefore needs Cognito permissions for
`AdminCreateUser`, `AdminSetUserPassword`, `AdminInitiateAuth`, and
`AdminDeleteUser`.

`COMMENTARY_ID_TOKEN` remains available as an override for environments that
must not create temporary users.

To trigger selected engines or change the client timeout:

```sh
COMMENTARY_ENGINES=openclaw,agentcore_runtime \
COMMENTARY_TIMEOUT_MS=65000 \
COMMENTARY_BASE_URL=https://frontend.example \
npm run test:commentary:aws
```
