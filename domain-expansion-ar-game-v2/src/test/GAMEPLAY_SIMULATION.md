# Gameplay simulation tests

`gameplaySimulation.test.tsx` mounts the real battle viewer and two real player
components. `InMemoryGameCoordinator` is the deterministic authoritative room;
Vitest fake time drives deadlines and grace windows, while scripted camera
frames drive the production stable gesture recognizer. Browser, media, robot,
commentary, and WebRTC boundaries are mocked.

Run the complete suite and enforced coverage thresholds with:

```sh
npm test
```
