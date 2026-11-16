# ORBIT gesture service

Local camera + MediaPipe hand/face tracking. Runs on the Windows laptop and
publishes a small JSON status stream over a WebSocket on `127.0.0.1:8790`.

**Nothing visual leaves this machine.** The desktop app receives landmark
coordinates and a phase, never a frame or an image.

## Setup

```bash
pip install mediapipe opencv-python websockets
```

Python 3.10+ is required. Model bundles (~12 MB) are downloaded on first run into
`models/` and cached; they are gitignored.

## Run

```bash
python services/gestures/serve.py
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `ORBIT_GESTURE_PORT` | `8790` | WebSocket port |
| `ORBIT_CAMERA_INDEX` | `0` | Which camera to open |
| `ORBIT_GESTURE_DEBUG` | unset | `1` prints every event to stderr |

Normally you do not run this by hand: the Electron app starts and stops it from
the **Gestures** page, and stops it on quit so the camera is never left running.

If the camera will not open, check **Settings → Privacy → Camera** and allow
desktop apps.

## The gestures

Two gestures, both requiring a **closed hand**. Proximity alone is never enough.

| Gesture | Condition | Holds for | Fires |
|---|---|---|---|
| Cup at mouth | closed hand within 0.75 face widths of the mouth | 600 ms | `dictation.start` |
| Fist in front | **right** closed hand 1.15 – 3.5 face widths away, held still | 450 ms | `window.grab` |
| Pointer | **right** palm only; its position in the frame maps to the screen | — | status only |
| Pinch to click | thumb–index within 0.50 hand-widths | 30 ms | `pointer.press`, then `pointer.release` |
| Three-finger scroll | thumb + index + middle pinched with the index still **extended** (curl < 0.50), ring and pinky **open**, then swept 5 % of the screen within 400 ms; one notch per 6 % of travel | — | `pointer.scroll` |
| Left-hand fist | **left** closed hand 1.15 – 3.5 face widths away, swept 0.20 screen widths sideways | — | `desktop.switch` |
| Throw | release a pinch while moving fast | — | `window.throw` |

How the decision is made:

1. **Curl first.** Each finger's tip-to-MCP span is compared with its MCP-to-PIP
   bone. An open finger reads ~1.9, a closed one under ~0.65; below the **0.55**
   curl gate nothing happens at all, so reaching past your face does not trigger
   anything. The measurement uses MediaPipe's **3D world landmarks** when they are
   available: a projection can make a fully balled, edge-on fist look extended,
   which is exactly why a real fist was missed. The 2D landmarks remain the
   fallback. The grab rule requires **middle, ring and pinky** to be closed and
   ignores the index, because a pinch necessarily curls it. One of those three
   may read partly open — the pinky often hides behind a balled fist — as long
   as the other two are strongly closed (curl ≥ 0.80). A pinch cannot reach that
   bar, so it keeps the click path. A loose cup with a partly extended index is
   therefore still a grab, not an open hand.
2. **Then position.** A closed hand is a cup or a fist depending only on how far it
   is from the mouth. The two bands **do not touch**: 0.75 to 1.15 face widths is a
   deliberate dead zone, so the actions cannot flicker into each other.
3. Distances are normalised by face width, so sitting further back does not change
   sensitivity.
4. Releasing emits a stop event and starts a cooldown: **1.5 s** after dictation,
   **400 ms** after a grabbed window is dropped, so a second window can be picked
   up promptly. Holding a fist up grabs once, not repeatedly.
5. If the hand or face is lost mid-hold for more than **400 ms**, the gesture is
   **cancelled**, never fired. A held grab also survives **300 ms** of missing
   `in_front` frames, because a real fist flickers at the edge of the band.
6. The pinch is **hysteretic**: press at 0.50 hand-widths, release at 0.68, so a
   click cannot chatter on the boundary. The button stays down while the pinch is
   held (that is what makes a drag), and one pinch presses once. While a window is
   being dragged the fist owns the hand: a frame misread as a pinch cannot click,
   scroll, or silently cancel the grab.
7. A **three-finger pinch** (thumb + index + middle) turns the wheel instead of
   clicking. The ring and pinky must stay open, the index must stay **extended**
   (curl < 0.50) because the gesture reaches rather than folds, and the middle
   tip must sit within 0.10 hand-widths of the index's distance from the thumb.
   The page **follows the hand**, like dragging it: travel is accumulated at
   **0.06 screen heights per notch**, so moving the hand up sends a negative
   wheel delta and the content moves up with it. A frame is discarded only when
   its **speed** exceeds 3.5 screen heights per second — a fixed per-frame
   distance silently threw away ordinary sweeps whenever the service dropped to
   5–10 fps, which is why the page moved about once a second. Travel beyond the
   3-notch per-frame cap is kept for the next frame rather than discarded.

   A closed hand is **not** a wheel until it has moved 5 % of the screen height
   within 400 ms. Live data showed a held fist reports ring/pinky curls of
   0.52–0.66 — inside the open-finger gate — so the index curl is what separates
   the poses, and movement is the second backstop: a fist held up to grab stays
   still, a wheel is a deliberate sweep. An armed wheel keeps the pose until the
   hand opens, so slowing down mid-scroll does not turn the drag into a grab.
8. A **throw** is judged only at the moment the pinch is released, using the last
   180 ms of movement. The dominant axis must beat the other by 1.6× so a
   diagonal does not claim a direction. Slow releases drop the panel where it is.
9. The pointer is **right-hand only**. A lone left hand reports no hand, so it
   cannot move the cursor. The camera frame is mirrored before inference, and
   MediaPipe's Task API explicitly reports inverted Left/Right for a mirrored
   image, so `tracker.py` swaps the labels back. Without that swap the cursor
   followed the left hand and the right hand's fist was ignored.
10. A **left-hand fist** held out switches virtual desktops. Sweeping it
    sideways at least 0.20 screen widths fires `desktop.switch`; the desktop
    helper sends Win+Ctrl+Left/Right, the same shortcut the four-finger trackpad
    swipe triggers. One switch per sweep, then an 800 ms cooldown so a wide
    sweep cannot fly through the whole row. The left hand never touches the
    cursor.
11. Gesture control must be **armed**. The desktop app arms it automatically by
    default; the **Enable hand control** toggle on the Gestures page disarms and
    re-arms it, and the choice is remembered. The protocol still requires an
    explicit `gesture.arm`.

Dictation is currently **simulated**: it emits `dictation.start` / `dictation.stop`
messages. No microphone is opened and no text is produced.

Grabbing the fist in front now moves the **real foreground OS window** with the
hand, as well as selecting the panel in the workspace. The Windows helper skips
ORBIT's own process, so if ORBIT is focused it moves the topmost other window. A
maximised window is restored before it moves. Opening the fist stops the move.
No receiver or iPad is required for any of this.

The **left** fist in front is the desktop switcher: sweep it sideways and the
active virtual desktop changes, exactly like the four-finger trackpad swipe.

## Camera health

MediaPipe finding no hand is not the same as "nobody is there": Windows can hand
the service a stream that reads successfully but contains only black frames,
usually when another app was still holding the webcam at startup. The service
measures the mean brightness of every frame and reports it as `cameraMean` /
`cameraDark`. If it stays below 6/255 for two seconds the device is reopened
(rate-limited to once every eight seconds). The Gestures page shows the
brightness and a warning banner while the stream is black.

A black preview in ORBIT is normal at first: the page draws landmarks, not
video. The brightness row and the warning are what distinguish "camera is
dead" from "empty chair".

## Logs

Everything this service writes to stdout and stderr is captured by the desktop
app and appended to its own rotating log, with the `gestures-py` scope:

```
%APPDATA%\@orbit\desktop\orbit\logs\orbit.log
```

That includes the startup lines (`listening on ...`, `camera open ...`), the
`[orbit-gestures] <event>` line for every fired gesture, and any traceback. The
Gestures page has an **Open logs** button for the folder. The file is written
synchronously, so it is still readable after a freeze or a hard kill — which is
the point: before this, all of it went only to the terminal that launched ORBIT.

## Layout

```
orbit_gestures/
  geometry.py   pure landmark maths, no camera or MediaPipe import
  machine.py    the state machine: hold, cooldown, lost-tracking handling
  tracker.py    camera capture + MediaPipe landmarkers
serve.py        WebSocket server and the capture loop
tests/          deterministic tests for geometry and the state machine
```

The split matters: `geometry.py` and `machine.py` have no hardware dependency,
so the behaviour is testable without a camera.

## Tests

```bash
python services/gestures/tests/test_gesture.py
```

Covers scale invariance, the "no face / no hand / face too small" refusals, hold
duration, short passes, cooldown blocking and expiry, lost-tracking cancellation,
single-frame drop tolerance, low confidence, and disarming while listening.

## Protocol

Client → service:

```json
{ "t": "gesture.arm" }
{ "t": "gesture.disarm" }
```

Service → client:

```json
{ "type": "status", "phase": "armed", "near": false, "distance": 1.42,
  "handVisible": true, "faceVisible": true, "confidence": 0.97,
  "landmarks": { "hand": [[x,y], ...], "face": [[x,y], ...] },
  "resolution": [640,480], "frames": 412, "fps": 29.4, "error": null }

{ "type": "event", "kind": "dictation.start", "phase": "listening",
  "message": "...", "at": 123456, "detail": { "distance": 0.22 } }
```

Event kinds: `armed`, `disarmed`, `gesture.hold`, `gesture.cancel`,
`gesture.reset`, `tracking.lost`, `dictation.start`, `dictation.stop`,
`pointer.press`, `pointer.release`, `pointer.scroll`, `window.grab`,
`window.release`, `window.throw`, `desktop.switch`.
