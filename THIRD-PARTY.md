# Third-party notices

ORBIT itself is MIT licensed (see `LICENSE`). It depends on, and in one case
redistributes, the following third-party work. Each remains under its own
license; nothing here changes those terms.

The list is what is actually installed — it was taken from the `license` field of
each package rather than from memory. Transitive dependencies are not enumerated:
every package manager here ships its own `LICENSE` inside the package.

## Vendored in this repository

`packages/receiver/public/mediapipe/` is committed so a fresh clone can serve the
iPad app without a download step. It is unmodified.

| Path | Project | License |
|---|---|---|
| `wasm/vision_wasm_internal.{js,wasm}` | MediaPipe Tasks (WASM runtime) | Apache-2.0 |
| `models/hand_landmarker.task` | MediaPipe Hand Landmarker | Apache-2.0 |
| `models/face_landmarker.task` | MediaPipe Face Landmarker | Apache-2.0 |

Upstream: <https://github.com/google-ai-edge/mediapipe> —
Apache License 2.0, <https://www.apache.org/licenses/LICENSE-2.0>.

The Python service downloads its own copies of the same models on first run
(`services/gestures/models/`, git-ignored); those are the same Apache-2.0 assets.

## Runtime dependencies

| Package | Where | License |
|---|---|---|
| `electron` | `packages/desktop` | MIT |
| `react`, `react-dom` | desktop renderer, receiver | MIT |
| `@mediapipe/tasks-vision` | receiver | Apache-2.0 |
| `ws` | desktop, server | MIT |
| `qrcode` | desktop | MIT |
| `electron-store` | desktop | MIT |
| `node-forge` | server (TLS) | BSD-3-Clause **or** GPL-2.0 — ORBIT uses it under BSD-3-Clause |
| `mediapipe` (Python) | `services/gestures` | Apache-2.0 |
| `opencv-python` (Python) | `services/gestures` | Apache-2.0 |
| `websockets` (Python) | `services/gestures` | BSD-3-Clause |

## Build and development only

| Package | License |
|---|---|
| `typescript` | Apache-2.0 |
| `vite`, `@vitejs/plugin-react` | MIT |
| `concurrently` | MIT |
| `tsx` | MIT |
| `wait-on` | MIT |
| `@types/*` | MIT |

## Note on `node-forge`

It is dual-licensed BSD-3-Clause or GPL-2.0. ORBIT elects **BSD-3-Clause**, which
is compatible with this project's MIT license and with closed distribution. If
that election is ever changed, `node-forge` must be replaced before ORBIT can be
shipped under MIT — GPL-2.0 and MIT are not compatible in that direction.
