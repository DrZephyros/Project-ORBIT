"""ORBIT gesture service.

Captures the laptop camera, runs MediaPipe hand + face landmarks locally, and
publishes a small status stream over a local WebSocket. Nothing visual leaves
this machine: the desktop app receives landmark coordinates and a phase, but the
video frames themselves are never sent anywhere.

Run:
    python services/gestures/serve.py

Environment:
    ORBIT_GESTURE_PORT   WebSocket port (default 8790)
    ORBIT_CAMERA_INDEX   Camera index (default 0)
    ORBIT_GESTURE_DEBUG  Set to 1 to print every event to stdout
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import replace as dataclass_replace
from pathlib import Path
from typing import Any

# Fail with an actionable message instead of a bare ImportError traceback. The
# desktop app surfaces this text directly to the user.
MISSING_DEPS_HINT = (
    "Install the gesture dependencies with:\n"
    "    pip install mediapipe opencv-python websockets\n"
)

try:
    from websockets.asyncio.server import ServerConnection, serve
except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
    sys.stderr.write(f"error: missing Python package '{exc.name}'.\n{MISSING_DEPS_HINT}")
    raise SystemExit(2) from exc

sys.path.insert(0, str(Path(__file__).resolve().parent))

from orbit_gestures.geometry import (  # noqa: E402
    PointerCalibration,
    PointerSmoother,
    ThrowTracker,
    calibration_from,
    detect_fist,
    detect_pointer,
    left_fist_closed,
    finger_curls,
    finger_curls_3d,
    landmark_payload,
    middle_pinch_distance,
    palm_frame,
    pick_hand_index,
    pointer_anchor,
    pose_metrics,
)
from orbit_gestures.machine import GestureConfig, GestureEvent, MouthGestureMachine  # noqa: E402
from orbit_gestures.gaze import (  # noqa: E402
    LAPTOP,
    TABLET,
    GazeCalibration,
    GazeRouter,
    head_pose,
)

try:
    from orbit_gestures.tracker import Tracker  # noqa: E402
except ModuleNotFoundError as exc:
    sys.stderr.write(f"error: missing Python package '{exc.name}'.\n{MISSING_DEPS_HINT}")
    raise SystemExit(2) from exc

PORT = int(os.environ.get("ORBIT_GESTURE_PORT", "8790"))
CAMERA_INDEX = int(os.environ.get("ORBIT_CAMERA_INDEX", "0"))
DEBUG = os.environ.get("ORBIT_GESTURE_DEBUG") == "1"
MODELS_DIR = Path(__file__).resolve().parent / "models"

# Where the user's neutral palm pose is remembered. Kept next to the service
# rather than in the desktop app's settings because it is meaningless without
# this exact camera and this exact MediaPipe model.
CALIBRATION_FILE = Path(__file__).resolve().parent / "calibration.json"

# Which head angle counts as "looking at the laptop" and "looking at the iPad".
# Kept apart from the pointer calibration because it is independent of it and
# can be redone on its own.
GAZE_FILE = Path(__file__).resolve().parent / "gaze_calibration.json"


def load_gaze(path: Path) -> GazeCalibration | None:
    """Read the saved gaze anchors, or None if there is none (or it is corrupt)."""
    try:
        return GazeCalibration.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def save_gaze(path: Path, calibration: GazeCalibration) -> None:
    try:
        path.write_text(json.dumps(calibration.as_dict(), indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[orbit-gestures] could not save gaze calibration: {exc}", file=sys.stderr)


def load_calibration(path: Path) -> PointerCalibration | None:
    """Read the saved neutral pose, or None if there is none (or it is corrupt)."""
    try:
        return PointerCalibration.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def save_calibration(path: Path, calibration: PointerCalibration) -> None:
    """Persist the neutral pose. A failure here is not fatal — the calibration
    still applies to this session, it just will not survive a restart."""
    try:
        path.write_text(json.dumps(calibration.as_dict(), indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[orbit-gestures] could not save calibration: {exc}", file=sys.stderr)

# Target cadence. MediaPipe on CPU handles 30fps for a single hand + face on a
# modern laptop; we cap the broadcast rate separately so the UI is not flooded.
MAX_FPS = 30
STATUS_HZ = 12
# The hand pointer gets its own stream. The desktop main process turns these into
# real OS cursor moves, and 12 Hz reads as a stuttering cursor; 30 Hz matches the
# camera loop and is what the eye expects from a pointer.
POINTER_HZ = 30

# How long the scroll pose stays "sticky" after it was last seen. Matches the
# wheel's own `scroll_grace_ms` in machine.GestureConfig: long enough that a
# single dropped frame cannot turn a scroll into a click, short enough that
# opening the hand ends the scroll immediately.
SCROLL_STICKY_MS = 250

# How many steady frames of the palm to average before treating it as the middle
# of the screen. Enough to ignore one frame of movement, few enough that the
# cursor is centred almost immediately after the hand comes into view.
AUTO_CENTER_SAMPLES = 8

# Frame-health recovery. A Windows camera opened while another process still
# holds it can return a stream that reads successfully but is pure black;
# MediaPipe then finds nothing and the UI looks like "no hand". Measuring the
# frame is the only way to tell that apart from an empty room. If it stays this
# dark for two seconds, reopen the device (rate-limited, because restarting a
# camera is slow and some laptops take a moment to release it).
DARK_FRAME_MEAN = 6.0
DARK_SECONDS_BEFORE_REOPEN = 2.0
REOPEN_COOLDOWN_S = 8.0


class GestureService:
    def __init__(self) -> None:
        self.machine = MouthGestureMachine(
            GestureConfig(hold_ms=600, cooldown_ms=1500, lost_tracking_grace_ms=400)
        )
        self.clients: set[ServerConnection] = set()
        self.tracker: Tracker | None = None
        self.error: str | None = None
        self.frames = 0
        self.last_status = 0.0
        self.last_pointer = 0.0
        self.running = True
        self._last_state: dict[str, Any] = {}
        # Velocity history for throws, and the pinch edge state for release.
        self.throws = ThrowTracker()
        self._was_pinching = False
        self._was_scrolling = False
        # When the scroll pose was last seen. Used to keep the scroll "sticky"
        # across a brief flicker without latching it on forever.
        self._scroll_seen_ms = 0
        self.pointer: tuple[float, float] | None = None
        self.pinching = False
        # The cursor follows the palm's position in the frame, so it only needs
        # light smoothing to take the edge off landmark jitter.
        self.smoother = PointerSmoother()
        # Palm origin + normal in metres, for the diagnostics panel and the
        # preview's palm marker. It no longer drives the cursor.
        self.ray: dict[str, list[float]] | None = None
        # Where the hand sits when the cursor should be in the middle, if the
        # user has calibrated. Without it the middle of the camera frame is
        # treated as the middle of the screen, which is rarely where the hand
        # actually rests.
        self.calibration = load_calibration(CALIBRATION_FILE)
        # Automatically found neutral point, used when the user has not
        # calibrated.
        #
        # Without one, `pointer_position` treats the middle of the *camera frame*
        # as the middle of the screen. Nobody holds their hand dead centre, so the
        # cursor started offset by however far off-centre the hand happened to
        # rest, and the user had to press Calibrate every single launch. Taking
        # the first steady sighting of the palm as the neutral point makes the
        # cursor start centred on its own.
        #
        # Kept in memory only: it is a starting guess for this run, and it must
        # never overwrite a deliberate calibration on disk.
        self._auto_center: tuple[float, float] | None = None
        self._auto_samples: list[tuple[float, float]] = []
        # The latest palm centre and the hand it came from, so a calibration
        # request can capture where the hand is *right now*.
        self._last_anchor: tuple[float, float] | None = None
        self._last_hand_label = ""

        # Gaze. The router decides which screen the user has turned to; the
        # anchors are captured one screen at a time, so a half-done calibration
        # is kept in memory but never persisted or trusted.
        self.gaze = load_gaze(GAZE_FILE)
        self.router = GazeRouter(self.gaze)
        self._gaze_anchor: dict[str, float] = {}
        if self.gaze is not None:
            self._gaze_anchor = {"laptop": self.gaze.yaw_laptop, "tablet": self.gaze.yaw_tablet}
        self.pose = None
        # The window currently held by the grab gesture, and where the user was
        # looking when they let go. Reported on release so the desktop can hand
        # the window to the iPad.
        self._grabbed = False
        # Frame health, so "the camera is black" is reported instead of looking
        # like an empty room.
        self.camera_mean = 0.0
        self.camera_dark = False
        self._dark_since: float | None = None
        self._last_reopen = 0.0

    # -- plumbing ----------------------------------------------------------
    async def handler(self, ws: ServerConnection) -> None:
        self.clients.add(ws)
        try:
            # Send the current snapshot immediately so a late-joining UI is not blank.
            await ws.send(json.dumps(self._last_state or {"type": "status", "initial": True}))
            async for raw in ws:
                await self.on_command(raw)
        except Exception:
            pass
        finally:
            self.clients.discard(ws)

    async def on_command(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(msg, dict):
            return

        kind = msg.get("t")
        now = int(time.monotonic() * 1000)
        events = []
        if kind == "gesture.arm":
            events = self.machine.arm(now)
        elif kind == "gesture.disarm":
            events = self.machine.disarm(now)
        elif kind == "gesture.calibrate":
            events = self._calibrate(now)
        elif kind == "gaze.calibrate":
            events = self._calibrate_gaze(now, str(msg.get("target") or LAPTOP))
        for event in events:
            await self.broadcast(self._event_payload(event))

    def _calibrate(self, now_ms: int) -> list[GestureEvent]:
        """Adopt where the hand is right now as "the middle of the screen".

        The cursor is driven by the palm's position, so the only thing that
        needs establishing is which position means centre. A person's hand
        rests somewhere below and to one side of the middle of the camera
        frame, so without this the cursor would be permanently offset.
        """
        if self._last_anchor is None:
            return [
                GestureEvent(
                    "pointer.calibrate.failed",
                    self.machine.phase,
                    "No palm to calibrate from — put your hand in view, then press Calibrate.",
                    now_ms,
                )
            ]

        self.calibration = PointerCalibration(
            self._last_anchor[0], self._last_anchor[1], self._last_hand_label
        )
        save_calibration(CALIBRATION_FILE, self.calibration)
        # A deliberate calibration replaces the learned neutral point, and must
        # survive for later runs, so the auto-centre stops applying entirely.
        self._auto_center = None
        self._auto_samples = []
        # The cursor is about to jump by exactly the offset we just removed.
        # Resetting the smoother makes it land on the centre immediately instead
        # of sliding across the screen.
        self.smoother.reset()
        return [
            GestureEvent(
                "pointer.calibrate",
                self.machine.phase,
                "Cursor centred — this hand position is now the middle of the screen.",
                now_ms,
                {
                    "x": round(self.calibration.x, 4),
                    "y": round(self.calibration.y, 4),
                    "hand": self.calibration.hand,
                },
            )
        ]

    def _calibrate_gaze(self, now_ms: int, target: str) -> list[GestureEvent]:
        """Record where the head is pointing right now as one of the two screens.

        Both anchors are captured the same way and neither is treated as
        "straight ahead": the laptop may sit off to one side of the camera, and
        the iPad could be on either side of the laptop. Requiring the user to
        show each screen once is the only way to be sure which is which.
        """
        if target not in (LAPTOP, TABLET):
            target = LAPTOP
        if self.router.yaw is None:
            return [
                GestureEvent(
                    "gaze.calibrate.failed",
                    self.machine.phase,
                    "No face in view — look toward the camera, then press again.",
                    now_ms,
                )
            ]

        self._gaze_anchor[target] = self.router.yaw
        if LAPTOP not in self._gaze_anchor or TABLET not in self._gaze_anchor:
            return [
                GestureEvent(
                    "gaze.calibrate.partial",
                    self.machine.phase,
                    f"Recorded the {target}. Now turn to the other screen and press its button.",
                    now_ms,
                    {"target": target, "yaw": round(self._gaze_anchor[target], 1)},
                )
            ]

        calibration = GazeCalibration(self._gaze_anchor[LAPTOP], self._gaze_anchor[TABLET])
        if not calibration.is_usable():
            # Two anchors on top of each other cannot separate anything, and
            # saving them would make the router flap between screens. Drop the
            # newer one and say why instead of half-working.
            del self._gaze_anchor[target]
            return [
                GestureEvent(
                    "gaze.calibrate.failed",
                    self.machine.phase,
                    f"Those two looked almost the same ({calibration.separation:.0f}° apart). "
                    "Turn your head further toward the iPad and try again.",
                    now_ms,
                )
            ]

        self.gaze = calibration
        self.router.calibration = calibration
        save_gaze(GAZE_FILE, calibration)
        return [
            GestureEvent(
                "gaze.calibrate",
                self.machine.phase,
                "Gaze routing ready. Look at a screen, then release the window to send it there.",
                now_ms,
                {
                    "laptop": round(calibration.yaw_laptop, 1),
                    "tablet": round(calibration.yaw_tablet, 1),
                    "separation": round(calibration.separation, 1),
                },
            )
        ]

    def _effective_calibration(
        self, anchor: tuple[float, float] | None
    ) -> PointerCalibration | None:
        """Which neutral point the cursor should use right now.

        A deliberate calibration always wins. Otherwise the neutral point is
        learned from the first steady sightings of the palm, so the cursor starts
        in the middle of the screen instead of wherever the middle of the camera
        frame happens to fall relative to the user's hand.

        Sampling stops as soon as a point is established. That matters: if the
        neutral point kept following the hand, moving the cursor would move its
        own origin and the cursor would drift forever.
        """
        if self.calibration is not None:
            return self.calibration
        if anchor is None:
            # No hand this frame. Keep whatever was learned; a gap must not
            # restart sampling and re-centre mid-gesture.
            return (
                None
                if self._auto_center is None
                else PointerCalibration(self._auto_center[0], self._auto_center[1], "")
            )

        if self._auto_center is None:
            self._auto_samples.append(anchor)
            # A few samples, not one: a single frame of a moving hand would bake
            # its position in as "centre" and leave a lasting offset.
            if len(self._auto_samples) >= AUTO_CENTER_SAMPLES:
                xs = sorted(p[0] for p in self._auto_samples)
                ys = sorted(p[1] for p in self._auto_samples)
                mid = len(xs) // 2
                self._auto_center = (xs[mid], ys[mid])
                self._auto_samples = []
                self.smoother.reset()

        if self._auto_center is None:
            return None
        return PointerCalibration(self._auto_center[0], self._auto_center[1], "")

    def _annotate(self, event: GestureEvent) -> None:
        """Attach the gaze destination to the end of a grab.

        The decision is made here, at the moment of release, from the target the
        router has been holding all along. Deriving it in the UI instead would
        mean shipping the whole yaw history across the wire and re-deciding it
        there, with two places to get the thresholds wrong.
        """
        if event.kind == "window.grab":
            self._grabbed = True
            return
        if event.kind == "pointer.press":
            # A pinch is a real mouse-down on the screen the head is turned to.
            # The same router that decides window releases decides this, so a
            # press while looking at the iPad is relayed there instead.
            event.detail["gaze"] = self.router.release_target()
            return
        if event.kind == "pointer.release":
            # Annotated separately: the head may have moved since the press.
            # The main process always releases the real button for safety, and
            # only relays to the iPad when the release belongs there.
            event.detail["gaze"] = self.router.release_target()
            return
        if event.kind == "pointer.scroll":
            # The wheel belongs to the screen the head is turned to, exactly
            # like a click. Without this the main process fell back to the last
            # pointer frame, so looking at the iPad still turned the laptop's
            # page under the cursor.
            event.detail["gaze"] = self.router.release_target()
            return
        if event.kind != "window.release":
            return

        self._grabbed = False
        # A decided target is enough: without anchors the router uses the
        # camera-relative default, so a fresh install still routes. A stale
        # target left over from before the head left frame is not a decision.
        target = self.router.release_target()
        calibrated = self.router.calibration is not None and self.router.calibration.is_usable()
        event.detail["gaze"] = target
        event.detail["gazeCalibrated"] = calibrated
        event.detail["gazeDefault"] = self.router.uses_default
        event.detail["gazeMode"] = self.router.snapshot()["mode"]
        event.detail["gazeSeen"] = self.router.target
        if target == TABLET:
            event.message = "Window released toward the iPad."
        elif target == LAPTOP:
            event.message = "Window released on the laptop."
        else:
            # Uncalibrated, or no face: stay put. Sending a window somewhere on
            # a guess is far worse than doing nothing.
            event.message = "Window released — nothing to route by, so it stays here."

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.clients:
            return
        data = json.dumps(payload)
        # Copy: a client can close while we iterate.
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except Exception:
                self.clients.discard(ws)

    def _event_payload(self, event: Any) -> dict[str, Any]:
        return {
            "type": "event",
            "kind": event.kind,
            "phase": event.phase.value,
            "message": event.message,
            "at": event.at_ms,
            "detail": event.detail,
        }

    # -- main loop ---------------------------------------------------------
    async def run(self) -> None:
        try:
            self.tracker = Tracker(MODELS_DIR, CAMERA_INDEX)
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            self.error = str(exc)
            print(f"[orbit-gestures] camera or model failure: {exc}", file=sys.stderr)
            await self.broadcast({"type": "error", "message": self.error})
            # Exit instead of idling with the port bound. A process that keeps
            # listening but never produces a frame is worse than a dead one: the
            # desktop app connects successfully and reports a zombie as running.
            self.running = False
            return

        print(f"[orbit-gestures] camera open, models in {MODELS_DIR}", file=sys.stderr)
        frame_interval = 1.0 / MAX_FPS
        # Measured loop throughput. Timing a single frame around the status block
        # divides by ~0, which is how the preview showed "1000000 fps"; a smoothed
        # frame-to-frame interval reports the real rate.
        last_tick = time.monotonic()
        smooth_fps = 0.0

        while self.running:
            frame_start = time.monotonic()
            if self.frames > 0:
                dt = frame_start - last_tick
                if dt > 0:
                    instant = 1.0 / dt
                    smooth_fps = instant if smooth_fps == 0.0 else smooth_fps * 0.85 + instant * 0.15
            last_tick = frame_start

            # MediaPipe is synchronous CPU work; keep it off the event loop so
            # arm/disarm commands are never blocked behind inference.
            frame, result = await asyncio.to_thread(self.tracker.read)
            self.frames += 1

            if not result.success:
                await asyncio.sleep(0.1)
                continue

            self.camera_mean = round(result.frame_mean, 1)
            self.camera_dark = result.frame_mean < DARK_FRAME_MEAN
            if self.camera_dark and self.frames > 90:
                now_mono = time.monotonic()
                if self._dark_since is None:
                    self._dark_since = now_mono
                elif (
                    now_mono - self._dark_since >= DARK_SECONDS_BEFORE_REOPEN
                    and now_mono - self._last_reopen >= REOPEN_COOLDOWN_S
                ):
                    self._last_reopen = now_mono
                    self._dark_since = None
                    reopened = await asyncio.to_thread(self.tracker.reopen_camera)
                    print(
                        "[orbit-gestures] camera stream was black; "
                        + ("reopened the device" if reopened else "reopen failed"),
                        file=sys.stderr,
                    )
            else:
                self._dark_since = None

            # Pick the hand to follow. The pointer is deliberately **right-hand
            # only**: `pick_hand_index` returns None when the right hand is not in
            # frame, even if a left hand is. That keeps the cursor, clicks and
            # grabs idle rather than following the wrong limb. Deliberately not
            # driven by the calibration label either, so a calibration taken in a
            # previous run cannot re-bind control to a left hand.
            preferred_hand = "Right"
            hand_index = pick_hand_index(result.hand_labels, prefer=preferred_hand)
            hand_detected = bool(result.hands)
            hand = (
                result.hands[hand_index]
                if hand_index is not None and hand_index < len(result.hands)
                else None
            )
            world_hand = (
                result.world_hands[hand_index]
                if hand_index is not None and hand_index < len(result.world_hands)
                else None
            )
            hand_label = (
                result.hand_labels[hand_index]
                if hand_index is not None and hand_index < len(result.hand_labels)
                else ""
            )
            hand_score = (
                result.hand_scores[hand_index]
                if hand_index is not None and hand_index < len(result.hand_scores)
                else 0.0
            )
            # Presence, not the handedness category score. MediaPipe leaves the
            # category unnamed on many frames; that is not a reason to stop
            # tracking a hand whose landmarks are right there.
            hand_confidence = 1.0 if hand is not None else 0.0
            face = result.faces[0] if result.faces else None

            # Remember where the palm is so a calibrate request can capture it.
            anchor = pointer_anchor(hand) if hand else None
            self._last_anchor = None if anchor is None else (anchor.x, anchor.y)
            self._last_hand_label = hand_label

            now_ms = int(time.monotonic() * 1000)

            # Head pose for gaze routing. This runs whether or not the gesture
            # machine is armed, so the Gestures tab can show the reading while
            # the user sets the two anchors up.
            matrix = result.face_matrices[0] if result.face_matrices else None
            self.pose = head_pose(matrix)
            self.router.observe(now_ms, self.pose.yaw if self.pose is not None else None)

            # Pointer and pinch. The pinch uses hysteresis internally, so we pass
            # in whether we were pinching on the previous frame.
            #
            # This runs *before* detect_fist because a pinch has to veto the
            # grab: pinching curls the fingers, and a curled hand is otherwise
            # indistinguishable from the fist that starts a grab.
            pointer = detect_pointer(
                hand,
                confidence=hand_confidence if hand else 0.0,
                was_pinching=self._was_pinching,
                # Only sticky for the same short window the wheel itself uses, so
                # a dropped frame cannot click mid-scroll but the scroll still
                # ends promptly once the hand actually opens.
                was_scrolling=(now_ms - self._scroll_seen_ms) <= SCROLL_STICKY_MS,
                world_hand=world_hand,
                calibration=self._effective_calibration(anchor),
            )
            # No neutral point yet means no usable cursor position.
            #
            # `detect_pointer` treats a missing calibration as "the middle of the
            # camera frame is the middle of the screen", which is only true if
            # the user happens to hold their hand dead centre. With the gain that
            # makes a comfortable sweep cross the screen, a hand even slightly
            # off-centre maps to an edge - and the first frames after every
            # launch are exactly when no neutral point has been learned yet.
            #
            # Reported as "it crashes immediately after it boots": the cursor was
            # pinned to the top-right corner of the screen while the auto-centre
            # was still sampling, and the next pinch landed on ORBIT's own close
            # button. So until a neutral point exists the service reports no
            # hand, and the desktop holds the cursor wherever it already is.
            if self.calibration is None and self._auto_center is None and pointer.hand_visible:
                pointer = dataclass_replace(
                    pointer,
                    x=0.0,
                    y=0.0,
                    pinch=False,
                    hand_visible=False,
                    reason="finding neutral point",
                )
            fist = detect_fist(
                hand,
                face,
                pinching=pointer.pinch,
                # Only a wheel that is actually *turning* suppresses the grab.
                #
                # This used to be `pointer.scrolling and machine.scroll_armed`.
                # A fist satisfies the three-finger pose too, so pairing it with
                # the armed flag meant that as soon as the wheel armed, the hand
                # was permanently reported as "scrolling" and `detect_fist`
                # short-circuited to in_front=False — the grab could never fire
                # again for the rest of the session. That is the report: "none of
                # the gestures except the pinch works".
                #
                # `machine.scrolling` is the wheel's own live state and ends with
                # it, so a settled fist is measured for the grab band again.
                scrolling=pointer.scrolling and self.machine.scrolling,
                world_hand=world_hand,
                # Once a window is held, the fist owns the frame: the far edge of
                # the pickup band must not end the drag when the hand sweeps out
                # to the side. See `detect_fist`'s `held` note.
                held=self.machine.grab_active,
            )
            if pointer.hand_visible:
                self.pointer = self.smoother.update((pointer.x, pointer.y), now_ms)
            else:
                self.smoother.reset()
                self.pointer = None
            self.pinching = pointer.pinch

            # High-rate pointer stream, separate from the 12 Hz status block.
            # The desktop main process feeds these straight into the Windows
            # cursor; the renderer never sees them, so the OS pointer stays
            # smooth without re-rendering React 30 times a second.
            pointer_now = time.monotonic()
            if pointer_now - self.last_pointer >= 1.0 / POINTER_HZ:
                self.last_pointer = pointer_now
                await self.broadcast(
                    {
                        "type": "pointer",
                        "x": None if self.pointer is None else round(self.pointer[0], 4),
                        "y": None if self.pointer is None else round(self.pointer[1], 4),
                        "handVisible": pointer.hand_visible,
                        "pinch": pointer.pinch,
                        # Sticky by a few frames: the scroll accumulator survives
                        # a pose flicker, so the cursor must stay frozen for the
                        # same window instead of stuttering.
                        "scrolling": pointer.scrolling or self.machine.scrolling,
                        # Lets the desktop suppress cursor movement while hand
                        # control is disarmed, without losing the position the
                        # preview still wants to draw.
                        "armed": self.machine.armed,
                        "gaze": self.router.release_target(),
                        "at": now_ms,
                    }
                )

            # The palm normal, kept only for the diagnostics panel. It no longer
            # drives the cursor — the hand cannot yaw a palm that faces the
            # camera, so orientation aiming could never reach the sides of the
            # screen.
            self.ray = None
            if world_hand and self.pointer is not None:
                palm = palm_frame(world_hand)
                if palm is not None:
                    _origin, _u, normal = palm
                    self.ray = {
                        "normal": [round(normal.x, 4), round(normal.y, 4), round(normal.z, 4)],
                        "hit": [round(self.pointer[0], 4), round(self.pointer[1], 4)],
                    }

            # Remember recent positions so a release can be judged as a throw.
            if pointer.hand_visible:
                self.throws.observe(now_ms, pointer.x, pointer.y, pointer.pinch)
            else:
                self.throws.reset()

            # Left hand: a fist held out switches virtual desktops, the way a
            # four-finger trackpad swipe does. Read separately so it works with
            # no right hand in frame, and it never touches the cursor: the
            # pointer stays bound to the right palm.
            left_index = pick_hand_index(result.hand_labels, prefer="Left")
            left_fist = False
            left_pointer: tuple[float, float] | None = None
            if (
                left_index is not None
                and left_index != hand_index
                and left_index < len(result.hands)
            ):
                left_hand = result.hands[left_index]
                left_world = (
                    result.world_hands[left_index]
                    if left_index < len(result.world_hands)
                    else None
                )
                # A closed left hand anywhere in frame, not just in the grab
                # band. The swipe is measured from the hand's own travel, and
                # requiring the mouth-distance band meant a hand held out to the
                # side - where a swipe begins - was never recognised at all.
                if left_fist_closed(left_hand, world_hand=left_world):
                    left_anchor = pointer_anchor(left_hand)
                    if left_anchor is not None:
                        left_fist = True
                        left_pointer = (left_anchor.x, left_anchor.y)

            events = self.machine.update(
                now_ms,
                at_mouth=fist.at_mouth,
                in_front=fist.in_front,
                hand_visible=fist.hand_visible,
                face_visible=fist.face_visible,
                distance=fist.distance,
                confidence=hand_confidence if hand else 0.0,
                curl=fist.curl,
                pointer=self.pointer,
                pinching=pointer.pinch,
                scrolling=pointer.scrolling,
                # The wheel accumulates the *raw* hand travel. The smoothed
                # pointer deliberately lags, so feeding it to the scroll made a
                # fast sweep arrive as a slow one and the page barely moved.
                scroll_pointer=(pointer.x, pointer.y) if pointer.hand_visible else None,
                left_fist=left_fist,
                left_pointer=left_pointer,
            )

            # A throw is a pinch that ends while the hand is still moving fast.
            # A scroll also ends the pinch, but that is a deliberate wheel
            # gesture, not a flick, so it must not throw the window.
            if self._was_pinching and not pointer.pinch and not pointer.scrolling:
                direction, speed = self.throws.direction(now_ms)
                events.extend(self.machine.throw(now_ms, direction.value, speed))
            self._was_pinching = pointer.pinch
            self._was_scrolling = pointer.scrolling
            if pointer.scrolling:
                self._scroll_seen_ms = now_ms

            for event in events:
                self._annotate(event)
                if DEBUG:
                    print(f"[orbit-gestures] {event.kind}: {event.message}", file=sys.stderr)
                await self.broadcast(self._event_payload(event))

            # Throttle status frames; events always go out immediately.
            now = time.monotonic()
            if now - self.last_status >= 1.0 / STATUS_HZ:
                self.last_status = now
                await self.broadcast(
                    {
                        "type": "status",
                        "machine": self.machine.snapshot(),
                        "atMouth": fist.at_mouth,
                        "inFront": fist.in_front,
                        "curled": fist.curled,
                        "curl": round(fist.curl, 3),
                        "fingerCurls": [round(c, 3) for c in finger_curls(hand)] if hand else [],
                        "fingerCurls3d": (
                            [round(c, 3) for c in finger_curls_3d(world_hand)] if world_hand else []
                        ),
                        "pinch": pointer.pinch,
                        "scrolling": pointer.scrolling,
                        # Scale-free reach measurements, published so the
                        # fist-versus-scroll gates can be tuned from a real hand
                        # instead of guessed from a projection.
                        "pose": pose_metrics(hand, world_hand),
                        "pinchDistance": (
                            None if pointer.pinch_distance == float("inf") else round(pointer.pinch_distance, 3)
                        ),
                        "middlePinchDistance": (
                            None
                            if hand is None
                            else (
                                None
                                if middle_pinch_distance(hand) == float("inf")
                                else round(middle_pinch_distance(hand), 3)
                            )
                        ),
                        "pointer": (
                            None if self.pointer is None else [round(self.pointer[0], 4), round(self.pointer[1], 4)]
                        ),
                        "pointerReason": pointer.reason,
                        "ray": self.ray,
                        "palm": (
                            None
                            if self._last_anchor is None
                            else [round(self._last_anchor[0], 4), round(self._last_anchor[1], 4)]
                        ),
                        "distance": None if fist.distance == float("inf") else round(fist.distance, 3),
                        "reason": fist.reason,
                        "handVisible": fist.hand_visible,
                        "handDetected": hand_detected,
                        "rightHand": hand_index is not None,
                        "leftFist": left_fist,
                        "faceVisible": fist.face_visible,
                        "handLabel": hand_label,
                        "calibrated": self.calibration is not None,
                        "gaze": {
                            **self.router.snapshot(),
                            "pitch": None if self.pose is None else round(self.pose.pitch, 1),
                        },
                        "confidence": round(hand_confidence, 3),
                        "handScore": round(hand_score, 3),
                        "landmarks": {
                            "hand": landmark_payload(hand),
                            "face": landmark_payload(face),
                            # Every hand the tracker found, so the preview can draw
                            # both skeletons. `hand` above is only the one driving
                            # the cursor (the right hand), and drawing just that
                            # made the left hand look untracked even though it was
                            # being detected and used for the desktop swipe.
                            "hands": [
                                {
                                    "label": (
                                        result.hand_labels[i]
                                        if i < len(result.hand_labels)
                                        else ""
                                    ),
                                    "points": landmark_payload(result.hands[i]),
                                }
                                for i in range(len(result.hands))
                            ],
                        },
                        "resolution": [result.width, result.height],
                        "frames": self.frames,
                        "fps": round(min(smooth_fps, MAX_FPS + 5.0), 1),
                        "cameraMean": self.camera_mean,
                        "cameraDark": self.camera_dark,
                        "error": self.error,
                    }
                )

            # Pace the loop; never busy-spin if inference was slow.
            elapsed = time.monotonic() - frame_start
            await asyncio.sleep(max(0.0, frame_interval - elapsed))

    async def stop(self) -> None:
        self.running = False
        if self.tracker:
            self.tracker.release()


async def main() -> None:
    service = GestureService()
    try:
        async with serve(service.handler, "127.0.0.1", PORT, max_size=2 * 1024 * 1024):
            print(f"[orbit-gestures] listening on ws://127.0.0.1:{PORT}", file=sys.stderr)
            loop = asyncio.create_task(service.run())
            try:
                await loop
            finally:
                await service.stop()
        # run() returning means the camera or the models failed. Exit non-zero so
        # the desktop app treats it as a crash and retries, instead of holding a
        # bound port with nothing behind it.
        if service.tracker is None:
            raise SystemExit(4)
    except OSError as exc:
        # Almost always a predecessor still holding the port. The desktop app
        # matches this text and retries with backoff instead of giving up, so a
        # clear one-liner here matters more than the traceback.
        sys.stderr.write(f"error: cannot bind port {PORT}: {exc}\n")
        sys.stderr.write("[orbit-gestures] port already in use\n")
        raise SystemExit(3) from exc


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
