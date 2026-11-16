"""Deterministic tests for the detector and state machine.

Run: python -m pytest services/gestures/tests -q
 or: python services/gestures/tests/test_gesture.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orbit_gestures.geometry import (  # noqa: E402
    FACE_LEFT_CHEEK,
    FACE_LOWER_LIP,
    FACE_RIGHT_CHEEK,
    FACE_UPPER_LIP,
    HAND_INDEX_MCP,
    HAND_INDEX_PIP,
    HAND_INDEX_TIP,
    HAND_MIDDLE_MCP,
    HAND_MIDDLE_TIP,
    HAND_PINKY_MCP,
    HAND_PINKY_TIP,
    HAND_THUMB_TIP,
    HAND_WRIST,
    POINTER_CENTER,
    POINTER_GAIN,
    Point,
    PointerCalibration,
    PointerSmoother,
    ThrowDirection,
    ThrowTracker,
    calibration_from,
    detect_fist,
    detect_mouth_contact,
    detect_pointer,
    left_fist_closed,
    palm_normal,
    pick_hand_index,
    pinch_distance,
    pointer_anchor,
    face_width,
    finger_curl,
    finger_curls,
    finger_curls_3d,
    fist_pose,
    middle_pinch_distance,
    mouth_centre,
    pose_metrics,
    swap_handedness,
    three_finger_pinch,
)
from orbit_gestures.machine import GestureConfig, MouthGestureMachine, Phase  # noqa: E402
from orbit_gestures.gaze import (  # noqa: E402
    LAPTOP,
    TABLET,
    GazeCalibration,
    GazeRouter,
    HeadPose,
    head_pose,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_face(width: float = 0.2, cx: float = 0.5, cy: float = 0.4) -> list[Point]:
    """A minimal face: two cheeks and a mouth. Nothing else is consulted."""
    face = [Point(0.5, 0.5) for _ in range(455)]
    left = cx - width / 2
    right = cx + width / 2
    face[FACE_LEFT_CHEEK] = Point(left, cy)
    face[FACE_RIGHT_CHEEK] = Point(right, cy)
    face[FACE_UPPER_LIP] = Point(cx, cy + 0.03)
    face[FACE_LOWER_LIP] = Point(cx, cy + 0.05)
    return face


def make_hand(tip: Point) -> list[Point]:
    hand = [Point(0.0, 0.0) for _ in range(21)]
    hand[HAND_WRIST] = Point(tip.x, tip.y + 0.2)
    hand[HAND_INDEX_TIP] = tip
    hand[HAND_MIDDLE_TIP] = Point(tip.x + 0.01, tip.y)
    hand[HAND_THUMB_TIP] = Point(tip.x - 0.01, tip.y)
    return hand


HAND_WRIST = 0


def make_fist(centred_at: Point, closed: bool = True, face_width_units: float = 0.16) -> list[Point]:
    """A hand whose curl we control.

    A closed hand draws each fingertip back toward the wrist, so the tip sits
    *closer* to the wrist than the finger's middle joint. An open hand does the
    opposite. Nothing else about the pose changes, which isolates the property
    the detector is supposed to measure.
    """
    hand = [Point(0.0, 0.0) for _ in range(21)]
    wrist_y = centred_at.y + 0.12
    hand[HAND_WRIST] = Point(centred_at.x, wrist_y)
    hand[10] = Point(centred_at.x, wrist_y - 0.10)
    hand[HAND_INDEX_MCP] = Point(centred_at.x - 0.03, wrist_y - 0.09)
    hand[HAND_PINKY_MCP] = Point(centred_at.x + 0.03, wrist_y - 0.09)

    for tip_index, joint_index in ((8, 6), (12, 10), (16, 14), (20, 18)):
        joint = Point(centred_at.x, wrist_y - 0.13)
        hand[joint_index] = joint
        hand[tip_index] = (
            Point(joint.x, joint.y + 0.02) if closed else Point(joint.x, joint.y - 0.07)
        )
    return hand


def make_partly_closed_hand(centred_at: Point) -> list[Point]:
    """A relaxed fist: index folded, the other three only half bent.

    A real fist is rarely fully balled. This reproduces the shape that used to be
    misread as a scroll wheel - the tips sit between the "open" and "curled"
    positions that the fixed fixtures use.
    """
    hand = [Point(0.0, 0.0) for _ in range(21)]
    wrist_y = centred_at.y + 0.12
    hand[HAND_WRIST] = Point(centred_at.x, wrist_y)
    hand[10] = Point(centred_at.x, wrist_y - 0.10)
    hand[HAND_INDEX_MCP] = Point(centred_at.x - 0.03, wrist_y - 0.09)
    hand[HAND_PINKY_MCP] = Point(centred_at.x + 0.03, wrist_y - 0.09)

    # Every finger needs its MCP, PIP and TIP: curl is measured as the span from
    # MCP to TIP over the MCP-PIP bone, so a missing MCP makes the ratio
    # meaningless and the curl saturates at 1.0.
    #
    # The index is folded part-way (curl about 0.45); the other three are bent
    # but not closed - the shape a hand holds while waiting to grab.
    chains = {"index": (5, 6, 8), "middle": (9, 10, 12), "ring": (13, 14, 16), "pinky": (17, 18, 20)}
    # Offsets are measured from the MCP, in the same units finger_curls uses.
    # MCP-PIP bone is 0.04, so curl = (1.9 - span/0.04) / 1.25.
    #   span 0.0535 -> curl 0.45  (a partly folded index)
    #   span 0.0750 -> curl 0.20  (bent, not folded)
    # index 0.46 (folded mid-way), ring/pinky about 0.55 (bent, not open). The
    # outer pair must be partly bent or the hand is just an open scroll.
    tip_span = {"index": 0.0530, "middle": 0.060, "ring": 0.056, "pinky": 0.056}
    xs = {"index": -0.03, "middle": -0.01, "ring": 0.01, "pinky": 0.03}
    for name, (mcp_i, pip_i, tip_i) in chains.items():
        mcp_y = wrist_y - 0.09
        hand[mcp_i] = Point(centred_at.x + xs[name], mcp_y)
        hand[pip_i] = Point(centred_at.x + xs[name], wrist_y - 0.13)
        hand[tip_i] = Point(centred_at.x + xs[name], mcp_y + tip_span[name])
    return hand


def make_anatomical_hand(centred_at: Point, curled: bool = False, pinching: bool = False) -> list[Point]:
    """A hand built with real finger proportions, not just tip/joint distances.

    This is the regression fixture for the "every hand is a fist" bug: with the
    old wrist-distance formula an open hand computed ~0.75 curl, so the grab
    detector fired for anyone who merely raised a hand. The index finger can also
    be folded into a pinch while the other three stay open, which is the pose the
    user reported as being misread.
    """
    hand = [Point(centred_at.x, centred_at.y) for _ in range(21)]
    hand[HAND_WRIST] = Point(centred_at.x, centred_at.y + 0.18)

    # Index, middle, ring, pinky: MCP, PIP, DIP, TIP.
    chains = ((5, 6, 7, 8), (9, 10, 11, 12), (13, 14, 15, 16), (17, 18, 19, 20))
    offsets = (-0.06, -0.02, 0.02, 0.06)
    heights = (-0.02, -0.03, -0.02, 0.0)
    for i, (mcp_i, pip_i, dip_i, tip_i) in enumerate(chains):
        mcp = Point(centred_at.x + offsets[i], centred_at.y + heights[i])
        pip = Point(mcp.x, mcp.y - 0.055)
        if curled:
            dip = Point(mcp.x, mcp.y - 0.02)
            tip = Point(mcp.x, mcp.y + 0.02)
        else:
            dip = Point(mcp.x, mcp.y - 0.10)
            tip = Point(mcp.x, mcp.y - 0.145)
        hand[mcp_i] = mcp
        hand[pip_i] = pip
        hand[dip_i] = dip
        hand[tip_i] = tip

    # Thumb: resting to the side when open, closing on the index tip for a pinch.
    hand[HAND_THUMB_TIP] = Point(centred_at.x - 0.10, centred_at.y + 0.02)
    if pinching:
        index_tip = Point(centred_at.x - 0.085, centred_at.y + 0.015)
        hand[HAND_INDEX_TIP] = index_tip
        hand[HAND_THUMB_TIP] = Point(index_tip.x - 0.005, index_tip.y - 0.005)
    return hand


def feed(machine: MouthGestureMachine, t: int, at_mouth: bool = False, in_front: bool = False,
         hand: bool = True, face: bool = True, distance: float = 0.3, curl: float = 0.9,
         confidence: float = 1.0, pointer=None, pinching: bool = False,
         scrolling: bool = False, left_fist: bool = False,
         left_pointer=None) -> list:
    """Call the machine with the full gesture signature."""
    return machine.update(
        t, at_mouth, in_front, hand, face, distance, confidence, curl,
        pointer=pointer, pinching=pinching, scrolling=scrolling,
        left_fist=left_fist, left_pointer=left_pointer,
    )

_results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    _results.append((name, condition, detail))


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def test_face_width() -> None:
    face = make_face(width=0.3)
    width = face_width(face)
    check("face_width measures cheek span", abs(width - 0.3) < 1e-6, f"got {width:.4f}")


def test_hand_at_mouth_is_near() -> None:
    face = make_face()
    hand = make_hand(Point(0.5, 0.44))  # ~mouth level
    result = detect_mouth_contact(hand, face)
    check("hand at mouth counts as near", result.near, f"distance={result.distance:.3f}")


def test_hand_far_away_is_not_near() -> None:
    face = make_face()
    hand = make_hand(Point(0.05, 0.05))
    result = detect_mouth_contact(hand, face)
    check("hand at frame corner is not near", not result.near, f"distance={result.distance:.3f}")


def test_distance_is_scale_invariant() -> None:
    """The same relative pose must pass whether you sit close or far.

    Distance is normalised by face width, so the hand has to be placed at the
    same *relative* offset from the mouth in both cases, not the same absolute
    pixel position.
    """
    near_face = make_face(width=0.4)
    far_face = make_face(width=0.12)

    near_mouth = mouth_centre(near_face)
    far_mouth = mouth_centre(far_face)
    assert near_mouth is not None and far_mouth is not None

    # 0.1 face-widths below the mouth in both frames.
    near_hand = make_hand(Point(near_mouth.x, near_mouth.y + 0.04))
    far_hand = make_hand(Point(far_mouth.x, far_mouth.y + 0.012))

    a = detect_mouth_contact(near_hand, near_face)
    b = detect_mouth_contact(far_hand, far_face)
    check(
        "threshold is independent of face size",
        a.near and b.near and abs(a.distance - b.distance) < 0.05,
        f"near={a.distance:.3f} far={b.distance:.3f}",
    )


def test_no_face_never_fires() -> None:
    result = detect_mouth_contact(make_hand(Point(0.5, 0.44)), None)
    check("no face never fires", not result.near, result.reason)


def test_no_hand_never_fires() -> None:
    result = detect_mouth_contact(None, make_face())
    check("no hand never fires", not result.near, result.reason)


def test_tiny_face_is_rejected() -> None:
    face = make_face(width=0.01)
    hand = make_hand(Point(0.5, 0.45))
    result = detect_mouth_contact(hand, face)
    check("face too small is not trusted", not result.near, result.reason)


def test_thumb_alone_can_trigger() -> None:
    """A cupped hand may present the thumb closest to the mouth."""
    face = make_face()
    hand = make_hand(Point(0.9, 0.9))
    hand[HAND_THUMB_TIP] = Point(0.5, 0.44)
    result = detect_mouth_contact(hand, face)
    check("any fingertip near the mouth triggers", result.near, f"distance={result.distance:.3f}")


# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------

def test_unarmed_machine_is_inert() -> None:
    machine = MouthGestureMachine()
    events = feed(machine, 0, at_mouth=True, distance=0.1)
    for t in range(0, 2000, 100):
        events.extend(feed(machine, t, at_mouth=True, distance=0.1))
    check("unarmed machine never fires", not any(e.kind == "dictation.start" for e in events))


def test_hold_elevation_fires_once() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=600, cooldown_ms=1000))
    machine.arm(0)
    starts = []
    for t in range(0, 2000, 100):
        for e in feed(machine, t, at_mouth=True, distance=0.1):
            if e.kind == "dictation.start":
                starts.append(t)
    check("hold fires exactly once", len(starts) == 1, f"fired at {starts}")
    check("hold waited for the hold duration", starts and starts[0] >= 600, f"first fire at {starts[0] if starts else None}ms")


def test_short_touch_does_not_fire() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=600))
    machine.arm(0)
    fired = False
    for t in range(0, 300, 100):
        fired |= any(e.kind == "dictation.start" for e in feed(machine, t, at_mouth=True, distance=0.1))
    # Released early.
    fired |= any(e.kind == "dictation.start" for e in feed(machine, 400, distance=3.0))
    check("a brief pass does not fire", not fired)


def test_stop_event_on_release() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=300, cooldown_ms=500))
    machine.arm(0)
    for t in range(0, 500, 100):
        feed(machine, t, at_mouth=True, distance=0.1)
    events = feed(machine, 500, distance=3.0)
    kinds = [e.kind for e in events]
    check("release emits dictation.stop", "dictation.stop" in kinds, str(kinds))
    check("phase returns to cooldown", machine.phase is Phase.COOLDOWN, machine.phase.value)


def test_cooldown_blocks_refire() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=200, cooldown_ms=2000))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, at_mouth=True, distance=0.1)
    feed(machine, 400, distance=3.0)  # start cooldown at 400 until 2400

    fired_again = False
    for t in range(500, 2300, 100):
        fired_again |= any(e.kind == "dictation.start" for e in feed(machine, t, at_mouth=True, distance=0.1))
    check("cooldown prevents immediate re-fire", not fired_again)


def test_refire_allowed_after_cooldown() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=200, cooldown_ms=500))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, at_mouth=True, distance=0.1)
    feed(machine, 400, distance=3.0)

    fired = False
    for t in range(1000, 2200, 100):
        fired |= any(e.kind == "dictation.start" for e in feed(machine, t, at_mouth=True, distance=0.1))
    check("can fire again after the cooldown", fired)


def test_lost_tracking_cancels_hold() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=600, lost_tracking_grace_ms=300))
    machine.arm(0)
    feed(machine, 0, at_mouth=True, distance=0.1)
    feed(machine, 200, at_mouth=True, distance=0.1)
    # Tracking disappears and never returns.
    events = []
    for t in range(300, 1200, 100):
        events.extend(feed(machine, t, hand=False, face=False, distance=float("inf")))
    kinds = [e.kind for e in events]
    check("lost tracking cancels the gesture", "gesture.reset" in kinds, str(kinds))
    check("lost tracking never fires dictation", "dictation.start" not in kinds)


def test_brief_tracking_gap_is_tolerated() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=300, lost_tracking_grace_ms=400))
    machine.arm(0)
    feed(machine, 0, at_mouth=True, distance=0.1)
    feed(machine, 150, at_mouth=True, distance=0.1)
    feed(machine, 200, hand=False, face=False, distance=float("inf"))  # one dropped frame
    fired = False
    for t in range(300, 900, 100):
        fired |= any(e.kind == "dictation.start" for e in feed(machine, t, at_mouth=True, distance=0.1))
    check("a single dropped frame does not cancel", fired)


def test_low_confidence_is_ignored() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=200, min_confidence=0.6))
    machine.arm(0)
    fired = False
    for t in range(0, 1200, 100):
        fired |= any(
            e.kind == "dictation.start"
            for e in feed(machine, t, at_mouth=True, distance=0.1, confidence=0.3)
        )
    check("low confidence never fires", not fired)


def test_disarm_stops_listening() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=100))
    machine.arm(0)
    for t in range(0, 300, 100):
        feed(machine, t, at_mouth=True, distance=0.1)
    events = machine.disarm(300)
    kinds = [e.kind for e in events]
    check("disarming while listening stops dictation", "dictation.stop" in kinds, str(kinds))
    check("disarmed phase is inactive", machine.phase is Phase.INACTIVE)


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Fist detection: curl separates open hand from closed hand
# ---------------------------------------------------------------------------

def test_open_hand_is_not_curled() -> None:
    hand = make_fist(Point(0.5, 0.5), closed=False)
    curl = finger_curl(hand)
    check("extended fingers read as not curled", curl < 0.55, f"curl={curl:.3f}")


def test_closed_hand_is_curled() -> None:
    hand = make_fist(Point(0.5, 0.5), closed=True)
    curl = finger_curl(hand)
    check("closed fingers read as curled", curl >= 0.55, f"curl={curl:.3f}")


def test_curl_is_scale_invariant() -> None:
    """Curling must not depend on how big the hand appears in the frame."""
    near = make_fist(Point(0.5, 0.5), closed=True)
    # Same pose, all points scaled up and shifted: still a fist.
    scaled = [Point(p.x * 1.0, p.y * 1.0) for p in near]
    a = finger_curl(near)
    b = finger_curl(scaled)
    check("curl is stable for a resized hand", abs(a - b) < 1e-6, f"{a:.3f} vs {b:.3f}")


def test_incomplete_hand_is_not_curled() -> None:
    partial = [Point(0.0, 0.0) for _ in range(9)]
    check("a hand missing fingertip landmarks is not treated as curled", finger_curl(partial) == 0.0)


# ---------------------------------------------------------------------------
# Cupped at mouth vs fist in front
# ---------------------------------------------------------------------------

def test_cup_at_mouth_is_detected() -> None:
    face = make_face()
    hand = make_fist(Point(0.5, 0.42), closed=True)
    reading = detect_fist(hand, face)
    check("closed hand at the mouth is a cup", reading.at_mouth, reading.reason)
    check("a cup is not reported as a front fist", not reading.in_front, reading.reason)


def test_fist_in_front_is_detected() -> None:
    face = make_face()
    # A fist raised in front of the chest sits well below the mouth but is still
    # within arm's reach of the camera.
    hand = make_fist(Point(0.5, 0.75), closed=True)
    reading = detect_fist(hand, face)
    check("closed hand held away from the mouth is in front", reading.in_front, reading.reason)
    check("a front fist is not reported as a cup", not reading.at_mouth, reading.reason)


def test_open_hand_never_triggers_either_gesture() -> None:
    face = make_face()
    for y in (0.42, 0.75):
        reading = detect_fist(make_fist(Point(0.5, y), closed=False), face)
        check(
            f"an open hand at y={y} triggers nothing",
            not reading.at_mouth and not reading.in_front,
            reading.reason,
        )


def test_anatomical_open_hand_is_not_a_fist() -> None:
    """Regression: a normal raised hand is not a grab.

    The old wrist-distance curl gave an open hand ~0.75, above the fist gate, so
    the app reported "fist in front" for everyone. This fixture uses realistic
    finger proportions instead of the exaggerated test pose.
    """
    face = make_face()
    hand = make_anatomical_hand(Point(0.5, 0.75), curled=False)
    reading = detect_fist(hand, face)
    check(
        "a real open hand is not curled",
        not reading.curled,
        f"curl={reading.curl:.2f} reason={reading.reason}",
    )
    check("a real open hand does not grab", not reading.in_front, reading.reason)


def test_anatomical_fist_is_a_fist() -> None:
    face = make_face()
    hand = make_anatomical_hand(Point(0.5, 0.75), curled=True)
    reading = detect_fist(hand, face)
    check("a real fist is curled", reading.curled, f"curl={reading.curl:.2f} reason={reading.reason}")
    check("a real fist in front grabs", reading.in_front, reading.reason)


def test_a_loose_cup_with_an_extended_index_is_still_a_fist() -> None:
    """A relaxed cup must not miss the grab because the index stayed out.

    The grab rule ignores the index (middle/ring/pinky decide), the same rule the
    pinch gate uses. Averaging all four fingers gave this pose ~0.42, below the
    gate, even though the hand is clearly closed — so a real cup was reported as
    "open hand" and never grabbed.
    """
    face = make_face()
    hand = make_anatomical_hand(Point(0.5, 0.75), curled=True)
    # Index stays extended; the other three are loosely curled at ~0.56.
    index_mcp = hand[HAND_INDEX_MCP]
    hand[HAND_INDEX_TIP] = Point(index_mcp.x, index_mcp.y - 0.145)
    for mcp_i, pip_i, tip_i in ((9, 10, 12), (13, 14, 16), (17, 18, 20)):
        mcp = hand[mcp_i]
        hand[pip_i] = Point(mcp.x, mcp.y - 0.055)
        hand[tip_i] = Point(mcp.x, mcp.y - 0.066)

    average = finger_curl(hand)
    reading = detect_fist(hand, face)
    check("the old four-finger average would have missed this cup", average < 0.55, f"curl={average:.2f}")
    check("a loose cup is still curled", reading.curled, f"curl={reading.curl:.2f} reason={reading.reason}")
    check("a loose cup in front still grabs", reading.in_front, reading.reason)


def test_anatomical_pinch_is_not_a_fist() -> None:
    """A pinch folds the index but leaves the other fingers open: not a grab."""
    face = make_face()
    hand = make_anatomical_hand(Point(0.5, 0.75), curled=False, pinching=True)
    fist = detect_fist(hand, face)
    pointer = detect_pointer(hand)
    check("a pinch is not curled into a fist", not fist.curled, f"curl={fist.curl:.2f} reason={fist.reason}")
    check(
        "a pinch still registers as a pinch",
        pointer.pinch,
        f"d={pointer.pinch_distance:.2f} curl={finger_curl(hand):.2f}",
    )


def test_midway_hand_is_in_neither_band() -> None:
    """The gap between the bands is what stops the two actions flickering."""
    face = make_face()
    reading = detect_fist(make_fist(Point(0.5, 0.60), closed=True), face)
    check(
        "a fist part-way between mouth and front does nothing",
        not reading.at_mouth and not reading.in_front,
        reading.reason,
    )


def test_no_face_never_triggers() -> None:
    reading = detect_fist(make_fist(Point(0.5, 0.42)), None)
    check("a fist with no face visible triggers nothing", not reading.at_mouth and not reading.in_front)


# ---------------------------------------------------------------------------
# State machine: the two gestures are independent
# ---------------------------------------------------------------------------

def test_cup_starts_dictation_after_hold() -> None:
    machine = MouthGestureMachine(GestureConfig(hold_ms=400))
    machine.arm(0)
    events = []
    for t in range(0, 700, 100):
        events.extend(feed(machine, t, at_mouth=True, distance=0.3))
    check(
        "cupped fist starts dictation",
        any(e.kind == "dictation.start" for e in events),
        str([e.kind for e in events]),
    )


def test_front_fist_grabs_window_after_hold() -> None:
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=300))
    machine.arm(0)
    events = []
    for t in range(0, 600, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6))
    check(
        "fist in front grabs the active window",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )
    check(
        "grabbing does not start dictation",
        not any(e.kind == "dictation.start" for e in events),
        str([e.kind for e in events]),
    )


def test_cup_never_grabs_and_fist_never_dictates() -> None:
    cup = MouthGestureMachine(GestureConfig(hold_ms=200))
    cup.arm(0)
    cup_events = []
    for t in range(0, 500, 100):
        cup_events.extend(feed(cup, t, at_mouth=True, distance=0.3))

    grip = MouthGestureMachine(GestureConfig(grab_hold_ms=200))
    grip.arm(0)
    grip_events = []
    for t in range(0, 500, 100):
        grip_events.extend(feed(grip, t, in_front=True, distance=1.6))

    check("a cup never grabs the window", not any(e.kind == "window.grab" for e in cup_events))
    check("a front fist never starts dictation", not any(e.kind == "dictation.start" for e in grip_events))


def test_grab_fires_once_per_raise() -> None:
    """Holding the fist up must not repeatedly grab."""
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200, cooldown_ms=100))
    machine.arm(0)
    events = []
    for t in range(0, 2000, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6))
    grabs = [e for e in events if e.kind == "window.grab"]
    check("holding the fist grabs exactly once", len(grabs) == 1, f"grabs={len(grabs)}")


def test_lowering_the_fist_releases_the_window() -> None:
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200))
    machine.arm(0)
    events = []
    for t in range(0, 500, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6))
    # The release waits for the grace period, so a one-frame dropout cannot end
    # the grab; a genuinely lowered fist still releases promptly.
    events.extend(feed(machine, 500, distance=3.0))
    check(
        "a single lowered frame does not release the grab",
        not any(e.kind == "window.release" for e in events),
        str([e.kind for e in events]),
    )
    events.extend(feed(machine, 900, distance=3.0))
    check(
        "lowering the fist releases the grab after the grace",
        any(e.kind == "window.release" for e in events),
        str([e.kind for e in events]),
    )


def test_a_flicker_frame_does_not_release_a_held_window() -> None:
    """The live bug: grab and release went out in the same millisecond.

    MediaPipe drops `in_front` for a frame at the edge of the band. Releasing on
    the first miss meant the physical window never moved at all.
    """
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, in_front=True, distance=1.6)
    events = feed(machine, 400, in_front=False, distance=1.05)
    check(
        "one flicker frame keeps the window grabbed",
        not any(e.kind == "window.release" for e in events),
        str([e.kind for e in events]),
    )
    events = feed(machine, 430, in_front=True, distance=1.6)
    check(
        "the fist coming back does not grab a second time",
        not any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )


def test_a_flicker_frame_does_not_restart_the_grab_hold() -> None:
    """The 450 ms hold used to reset on every dropped frame.

    Live data showed `grab.hold` restarting three times in a second because
    `in_front` blinked, so the hold never completed even though the fist was up.
    """
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=300, cooldown_ms=100))
    machine.arm(0)
    feed(machine, 0, in_front=True, distance=1.6)
    feed(machine, 100, in_front=False, distance=1.05)
    events = feed(machine, 320, in_front=True, distance=1.6)
    check(
        "the hold accumulates across a flicker",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )


def test_a_pinch_cannot_cancel_a_held_grab() -> None:
    """Live bug: a balled fist's thumb rests by the index and reads as a pinch.

    The pinch path cleared the grab without emitting `window.release`. The
    desktop kept dragging a window the service had already forgotten, and the
    next fist frame re-based that window at its original corner — which is why
    dragging was glitchy and only worked once.
    """
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200, cooldown_ms=100))
    machine.arm(0)
    events = []
    for t in range(0, 400, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6, curl=0.8))
    kinds = [e.kind for e in events]
    check("the fist grabbed the window", kinds.count("window.grab") == 1, str(kinds))

    # One frame the recogniser calls a pinch while the fist is still out there.
    glitch = feed(machine, 400, in_front=True, distance=1.6, curl=0.8, pinching=True, pointer=(0.5, 0.5))
    kinds = [e.kind for e in glitch]
    check("a misread pinch does not click mid-drag", "pointer.press" not in kinds, str(kinds))
    check("a misread pinch does not drop the grab", "window.release" not in kinds, str(kinds))

    # Back to a clean fist: it is the same grab, not a new one.
    after = feed(machine, 500, in_front=True, distance=1.6, curl=0.8)
    check(
        "the same fist does not grab a second time",
        not any(e.kind == "window.grab" for e in after),
        str([e.kind for e in after]),
    )
    check("the grab is still reported as held", machine.snapshot()["grabbed"] == 1, str(machine.snapshot()))

    # And a genuinely lowered fist still lets go.
    feed(machine, 900, in_front=False, distance=3.0, curl=0.2)
    released = feed(machine, 1300, in_front=False, distance=3.0, curl=0.2)
    check(
        "lowering the fist still releases the window",
        any(e.kind == "window.release" for e in released),
        str([e.kind for e in released]),
    )


def test_a_misread_scroll_cannot_spin_the_page_mid_drag() -> None:
    """The three-finger pose is also close to a fist, so it can fire by mistake.

    While a window is being dragged, the wheel must stay silent: turning the
    page under a moving window is never what the user meant.
    """
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, in_front=True, distance=1.6, curl=0.8)

    events = feed(
        machine,
        400,
        in_front=True,
        distance=1.6,
        curl=0.8,
        scrolling=True,
        pointer=(0.5, 0.5),
    )
    events += feed(
        machine,
        450,
        in_front=True,
        distance=1.6,
        curl=0.8,
        scrolling=True,
        pointer=(0.5, 0.4),
    )
    check(
        "a misread scroll does not turn the wheel mid-drag",
        not any(e.kind == "pointer.scroll" for e in events),
        str([e.kind for e in events]),
    )


def test_a_second_grab_works_soon_after_releasing() -> None:
    """Dropping a window and picking up another must not need a 2 s pause."""
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200, grab_cooldown_ms=400, cooldown_ms=5000))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, in_front=True, distance=1.6, curl=0.8)
    feed(machine, 400, in_front=False, distance=3.0, curl=0.2)
    released = feed(machine, 800, in_front=False, distance=3.0, curl=0.2)
    check(
        "the first window was released",
        any(e.kind == "window.release" for e in released),
        str([e.kind for e in released]),
    )

    events = []
    for t in range(900, 1600, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6, curl=0.8))
    check(
        "a fresh fist grabs a second window",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )


def test_grab_cancelled_when_released_early() -> None:
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=500))
    machine.arm(0)
    feed(machine, 0, in_front=True, distance=1.6)
    events = feed(machine, 200, distance=3.0)
    check(
        "a brief fist does not grab",
        not any(e.kind in ("window.grab", "window.release") for e in events),
        str([e.kind for e in events]),
    )


def test_lost_tracking_cancels_a_grab() -> None:
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200, lost_tracking_grace_ms=200))
    machine.arm(0)
    events = []
    for t in range(0, 400, 100):
        events.extend(feed(machine, t, in_front=True, distance=1.6))
    for t in range(400, 900, 100):
        events.extend(feed(machine, t, hand=False, face=False, distance=float("inf")))
    check(
        "losing the hand mid-grab resets instead of holding it forever",
        len([e for e in events if e.kind == "window.grab"]) == 1,
        str([e.kind for e in events]),
    )


def test_disarm_releases_a_held_window() -> None:
    machine = MouthGestureMachine(GestureConfig(grab_hold_ms=200))
    machine.arm(0)
    for t in range(0, 400, 100):
        feed(machine, t, in_front=True, distance=1.6)
    events = machine.disarm(400)
    releases = [e for e in events if e.kind == "window.release"]
    check(
        "disarming while holding a window releases it",
        bool(releases),
        str([e.kind for e in events]),
    )
    check(
        "a disarm releases the window as a cancel, not a handoff",
        bool(releases) and releases[0].detail.get("cancelled") is True,
        str(releases[0].detail if releases else None),
    )



# ---------------------------------------------------------------------------
# Pointer
# ---------------------------------------------------------------------------

def make_aiming_hand(cx: float = 0.5, cy: float = 0.5, pinched: bool = False) -> list[Point]:
    """An open hand whose palm centre (the index/pinky knuckle midpoint) is at cx, cy.

    Only the landmarks the pointer path reads are placed: the two outer knuckles
    (which are the anchor) and the two fingertips (which are the pinch). Everything
    else is parked at the palm centre so a stray default cannot leak into a test.
    """
    hand = [Point(cx, cy) for _ in range(21)]
    hand[HAND_WRIST] = Point(cx, cy + 0.12)
    hand[10] = Point(cx, cy - 0.02)
    hand[HAND_INDEX_MCP] = Point(cx - 0.03, cy)
    hand[HAND_PINKY_MCP] = Point(cx + 0.03, cy)
    hand[HAND_INDEX_TIP] = Point(cx - 0.03, cy - 0.06)
    hand[HAND_MIDDLE_TIP] = Point(cx, cy - 0.08)
    hand[HAND_THUMB_TIP] = Point(cx - 0.02, cy - 0.05) if pinched else Point(cx - 0.07, cy - 0.02)
    return hand


def make_pointing_hand(x: float, y: float, pinched: bool) -> list[Point]:
    """A hand whose index tip is at (x, y) and whose thumb is near or far.

    Used for pinch tests: the pinch threshold is measured between the thumb and
    index tips, normalised by the span between the outer knuckles.
    """
    hand = make_fist(Point(x, y), closed=False)
    hand[HAND_INDEX_MCP] = Point(x - 0.03, y + 0.06)
    hand[HAND_PINKY_MCP] = Point(x + 0.03, y + 0.06)  # width 0.06
    hand[HAND_INDEX_PIP] = Point(x, y + 0.045)
    hand[HAND_INDEX_TIP] = Point(x, y)
    # Pinched means the thumb is almost touching the fingertip.
    hand[HAND_THUMB_TIP] = Point(x + 0.01, y + 0.01) if pinched else Point(x + 0.05, y + 0.02)
    return hand


def make_scroll_hand(x: float = 0.5, y: float = 0.5, ring_open: bool = True,
                     pinky_open: bool = True) -> list[Point]:
    """Thumb + index + middle pinched with the fingers *reaching*, not folded.

    A real scroll extends the index and middle out to meet the thumb, so the
    index stays fairly straight (curl ~0.14). The old fixture folded the index
    back into the palm to bring its tip to the thumb; that produced curl 0.89,
    which is a fist with a thumb next to it, and the detector now refuses it.
    """
    hand = make_anatomical_hand(Point(x, y), curled=False)
    pinch = Point(x - 0.06, y - 0.115)
    hand[HAND_INDEX_TIP] = pinch
    hand[HAND_MIDDLE_TIP] = Point(pinch.x + 0.004, pinch.y + 0.004)
    hand[HAND_THUMB_TIP] = Point(pinch.x - 0.003, pinch.y - 0.003)
    for tip_i, mcp_i, keep_open in ((16, 13, ring_open), (20, 17, pinky_open)):
        if keep_open:
            continue
        mcp = hand[mcp_i]
        hand[tip_i] = Point(mcp.x, mcp.y + 0.02)
    return hand


def cursor_at(cx: float, cy: float, calibration=None) -> tuple[float, float]:
    reading = detect_pointer(make_aiming_hand(cx, cy), calibration=calibration)
    return (reading.x, reading.y)


def make_world_hand(
    palm_x: float = 0.0,
    palm_y: float = 0.0,
    yaw_deg: float = 0.0,
    pitch_deg: float = 0.0,
) -> list[Point]:
    """Metric 3D landmarks for an open hand, as MediaPipe's world landmarks give.

    Mirrors a relaxed right hand held up facing the camera: wrist below, three
    knuckles across the palm. `yaw_deg` turns the palm left/right (about the
    vertical axis) and `pitch_deg` tips it up/down (about the horizontal axis);
    `palm_x`/`palm_y` slide the whole hand without changing its orientation.

    These are *metres* with the same scale as real world landmarks (a palm is
    about 6cm across). Note that real world landmarks are hand-centred, so
    `palm_x`/`palm_y` here are only meaningful for orientation tests — the
    pointer no longer reads a position from them.
    """
    base = {
        HAND_WRIST: (0.000, -0.095, 0.0),
        HAND_INDEX_MCP: (0.032, -0.070, 0.0),
        HAND_MIDDLE_MCP: (0.008, -0.074, 0.0),
        HAND_PINKY_MCP: (-0.026, -0.068, 0.0),
    }

    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)

    def rotate(x: float, y: float, z: float) -> tuple[float, float, float]:
        # Pitch about x (tip up/down), then yaw about y (turn left/right).
        y, z = y * math.cos(pitch) - z * math.sin(pitch), y * math.sin(pitch) + z * math.cos(pitch)
        x, z = x * math.cos(yaw) + z * math.sin(yaw), -x * math.sin(yaw) + z * math.cos(yaw)
        return (x, y, z)

    hand = [Point(palm_x, palm_y, 0.0) for _ in range(21)]
    for index, (x, y, z) in base.items():
        rx, ry, rz = rotate(x, y, z)
        hand[index] = Point(palm_x + rx, palm_y + ry, rz)
    return hand


def test_cursor_follows_the_palm() -> None:
    """Move the hand right and the cursor goes right; move it down, the cursor
    goes down. This is the whole contract of a position-based pointer."""
    left = cursor_at(0.40, 0.50)
    right = cursor_at(0.60, 0.50)
    up = cursor_at(0.50, 0.40)
    down = cursor_at(0.50, 0.60)
    check("moving the hand right moves the cursor right", right[0] > left[0], f"{left[0]:.3f} -> {right[0]:.3f}")
    check("moving the hand down moves the cursor down", down[1] > up[1], f"{up[1]:.3f} -> {down[1]:.3f}")
    check("horizontal movement does not change y", abs(left[1] - right[1]) < 1e-9, f"{left[1]} vs {right[1]}")
    check("vertical movement does not change x", abs(up[0] - down[0]) < 1e-9, f"{up[0]} vs {down[0]}")


def test_a_comfortable_sweep_reaches_both_edges() -> None:
    """A hand sweep of +-0.2 of the frame must cover the whole screen.

    A person's hand travels about 40% of the camera frame width comfortably, so
    the gain has to turn that into the full screen width or the corners are
    unreachable — which is what made the orientation version useless.
    """
    left = cursor_at(0.30, 0.50)
    right = cursor_at(0.70, 0.50)
    check("a hand at the left of the sweep reaches the left edge", left[0] <= 0.01, f"{left[0]:.3f}")
    check("a hand at the right of the sweep reaches the right edge", right[0] >= 0.99, f"{right[0]:.3f}")


def test_a_comfortable_lift_reaches_top_and_bottom() -> None:
    """The same for vertical travel, which is shorter, so the gain is higher."""
    up = cursor_at(0.50, 0.31)
    down = cursor_at(0.50, 0.69)
    check("raising the hand reaches the top", up[1] <= 0.01, f"{up[1]:.3f}")
    check("lowering the hand reaches the bottom", down[1] >= 0.99, f"{down[1]:.3f}")


def test_a_small_move_is_visible() -> None:
    """Sensitivity: 4% of the frame must be 10% of the screen.

    Without this the cursor only moves when the hand is thrown across the frame,
    which reads as "it barely responds".
    """
    a = cursor_at(0.50, 0.50)
    b = cursor_at(0.54, 0.50)
    moved = b[0] - a[0]
    check("a 4% hand move moves the cursor at least 8% of the screen", moved >= 0.08, f"moved {moved:.3f}")


def test_rolling_the_hand_does_not_move_the_cursor() -> None:
    """The anchor is the midpoint of the knuckle line, which is roll-invariant.

    Rolling the hand rotates the knuckle line about its own centre, so the
    midpoint does not move. That is deliberate: a rolled hand is not a move.
    """
    flat = make_aiming_hand(0.5, 0.5)
    rolled = make_aiming_hand(0.5, 0.5)
    # Rotate the knuckle line by 25 degrees about the palm centre.
    roll = math.radians(25)
    for index in (HAND_INDEX_MCP, HAND_PINKY_MCP):
        p = rolled[index]
        dx, dy = p.x - 0.5, p.y - 0.5
        rolled[index] = Point(0.5 + dx * math.cos(roll) - dy * math.sin(roll),
                              0.5 + dx * math.sin(roll) + dy * math.cos(roll))

    a = detect_pointer(flat)
    b = detect_pointer(rolled)
    check("rolling the hand does not move the cursor", abs(a.x - b.x) < 1e-9 and abs(a.y - b.y) < 1e-9,
          f"{a.x:.3f},{a.y:.3f} vs {b.x:.3f},{b.y:.3f}")


def test_the_middle_knuckle_does_not_steer_the_cursor() -> None:
    """The anchor is the two *outer* knuckles, so the middle one cannot drag it."""
    base = detect_pointer(make_aiming_hand(0.5, 0.5))
    jittered_hand = make_aiming_hand(0.5, 0.5)
    jittered_hand[HAND_MIDDLE_MCP] = Point(0.5, 0.5)
    jittered_hand[10] = Point(0.62, 0.38)
    jittered = detect_pointer(jittered_hand)
    check("a wobbly middle knuckle does not move the cursor",
          abs(jittered.x - base.x) < 1e-9 and abs(jittered.y - base.y) < 1e-9,
          f"{base.x:.3f},{base.y:.3f} vs {jittered.x:.3f},{jittered.y:.3f}")


def test_world_landmarks_do_not_move_the_cursor() -> None:
    """World landmarks are hand-centred, so they must not be mixed in.

    They carry no absolute position: the origin is the hand itself. An earlier
    version added their x/y to the cursor, which contributed a constant and made
    the pointer feel like it was ignoring the hand.
    """
    hand = make_aiming_hand(0.62, 0.44)
    with_world = detect_pointer(hand, world_hand=make_world_hand(palm_x=0.1, palm_y=-0.1))
    without = detect_pointer(hand)
    check("adding world landmarks does not change the cursor",
          abs(with_world.x - without.x) < 1e-9 and abs(with_world.y - without.y) < 1e-9,
          f"{without.x:.3f},{without.y:.3f} vs {with_world.x:.3f},{with_world.y:.3f}")


def test_an_edge_on_palm_still_gets_a_cursor() -> None:
    """Position mapping does not care how the palm is angled.

    The orientation version had to refuse an edge-on palm because the ray became
    meaningless. A position pointer has no such failure mode, which is one more
    reason it is the right tool here.
    """
    edge_on = detect_pointer(make_aiming_hand(0.5, 0.5), world_hand=make_world_hand(yaw_deg=90))
    check("an edge-on palm still reports a cursor", edge_on.hand_visible, edge_on.reason)


def test_pointer_is_clamped_to_the_screen() -> None:
    """The hand can leave the frame; the cursor cannot leave the screen."""
    far_right = detect_pointer(make_aiming_hand(1.4, 0.5))
    far_down = detect_pointer(make_aiming_hand(0.5, 1.4))
    check("pointer x cannot leave the screen", 0.0 <= far_right.x <= 1.0, f"x={far_right.x}")
    check("an extreme position reaches the right edge", far_right.x >= 0.99, f"x={far_right.x}")
    check("pointer y cannot leave the screen", 0.0 <= far_down.y <= 1.0, f"y={far_down.y}")
    check("an extreme position reaches the bottom", far_down.y >= 0.99, f"y={far_down.y}")


# ---------------------------------------------------------------------------
# Calibration: which hand position means "the middle"
# ---------------------------------------------------------------------------

def test_calibration_centres_the_cursor() -> None:
    """The captured position becomes dead centre, and offsets stay proportional."""
    calibration = calibration_from(make_aiming_hand(0.42, 0.58), label="Left")
    assert calibration is not None

    centred = cursor_at(0.42, 0.58, calibration)
    check("the calibrated position is dead centre",
          abs(centred[0] - 0.5) < 1e-9 and abs(centred[1] - 0.5) < 1e-9, f"{centred}")

    # 0.10 of frame width right of the calibrated point = 0.35 of screen at the
    # current gain of 3.5.
    shifted = cursor_at(0.52, 0.58, calibration)
    check("a shift from the calibrated point scales by the gain",
          abs(shifted[0] - 0.85) < 1e-9, f"{shifted[0]:.3f}")


def test_calibration_keeps_the_full_screen_reachable() -> None:
    """Calibrating off-centre must not eat the range on one side."""
    calibration = calibration_from(make_aiming_hand(0.40, 0.55))
    assert calibration is not None
    left = cursor_at(0.20, 0.55, calibration)
    right = cursor_at(0.60, 0.55, calibration)
    check("the left edge is still reachable after calibrating", left[0] <= 0.01, f"{left[0]:.3f}")
    check("the right edge is still reachable after calibrating", right[0] >= 0.99, f"{right[0]:.3f}")


def test_calibration_survives_a_round_trip_through_json() -> None:
    """The calibration is stored on disk, so it has to survive serialisation."""
    original = calibration_from(make_aiming_hand(0.42, 0.58), label="Left")
    assert original is not None
    restored = PointerCalibration.from_dict(json.loads(json.dumps(original.as_dict())))
    # `as_dict` rounds to six decimals so the file stays readable.
    check(
        "a saved calibration reloads unchanged",
        restored is not None
        and abs(restored.x - original.x) < 1e-6
        and abs(restored.y - original.y) < 1e-6,
        f"{restored} vs {original}",
    )
    check("the hand label is kept", restored is not None and restored.hand == "Left")


def test_a_corrupt_or_stale_calibration_file_is_ignored() -> None:
    """A half-written file, or one from the old aim-based calibration, must not
    be mistaken for image coordinates — those numbers are palm tangents and
    would park the cursor in a corner."""
    bad = (
        None,
        {},
        {"x": "nope", "y": 0.5},
        {"x": 0.5},
        {"aim_x": -0.25, "aim_y": 0.14},      # old format
        {"x": -0.25, "y": 1.9},               # out of range
        "garbage",
        [],
    )
    for raw in bad:
        check(f"bad calibration {raw!r} is rejected", PointerCalibration.from_dict(raw) is None)


def test_calibration_needs_a_visible_palm() -> None:
    """There is nothing to capture if the landmarks are incomplete."""
    check("no hand means no calibration", calibration_from([]) is None)


def test_only_the_right_hand_drives_the_cursor() -> None:
    """Only the right hand may move the pointer or fire a gesture.

    With both hands in frame MediaPipe returns both, and picking "whichever
    scored higher" let the resting left hand steal the cursor. A lone left hand
    must not enable control at all, so the service reports no hand.
    """
    check("the right hand drives the cursor when it is second", pick_hand_index(["Left", "Right"]) == 1)
    check("the right hand drives the cursor when it is first", pick_hand_index(["Right", "Left"]) == 0)
    check("a lone left hand never drives the cursor", pick_hand_index(["Left"]) is None)
    check("labels are matched case-insensitively", pick_hand_index(["left", "right"]) == 1)
    check("the calibrated hand is preferred over the default", pick_hand_index(["Right", "Left"], prefer="Left") == 1)
    check("no hands reports nothing", pick_hand_index([]) is None)


def test_mirrored_labels_are_swapped_back() -> None:
    """A mirrored frame inverts handedness, so the labels must be exchanged.

    MediaPipe's Task API documents this explicitly. Without the swap the user's
    right hand was labelled "Left", `pick_hand_index` found no right hand, and
    the pointer followed the left hand while every right-hand fist was ignored.
    """
    check("left becomes right", swap_handedness(["Left"]) == ["Right"])
    check("right becomes left", swap_handedness(["Right"]) == ["Left"])
    check("the pairing order is preserved", swap_handedness(["Left", "Right"]) == ["Right", "Left"])
    check("matching is case-insensitive", swap_handedness(["left", "RIGHT"]) == ["Right", "Left"])
    check("an empty label is not invented into a hand", swap_handedness([""]) == [""])
    check("no hands stays empty", swap_handedness([]) == [])

    # End to end: MediaPipe labels the user's physical right hand "Left" in a
    # mirrored frame; after the swap it is the one the pointer selects.
    swapped = swap_handedness(["Left"])
    check("the user's right hand is selected after the swap", pick_hand_index(swapped) == 0)


def test_palm_normal_still_points_at_the_camera() -> None:
    """The normal is only shown for diagnostics now, but it should still be sane."""
    normal = palm_normal(make_world_hand())
    assert normal is not None
    check("a palm facing the camera has a normal pointing at it", normal.z < -0.9, f"z={normal.z:.3f}")
    check("a palm facing the camera has no sideways component", abs(normal.x) < 0.05, f"x={normal.x:.3f}")


def test_smoother_holds_on_a_missing_frame() -> None:
    """A frame with no usable hit must not move or clear the cursor."""
    smoother = PointerSmoother(alpha=1.0)
    smoother.update((0.4, 0.6), 0)
    held = smoother.update(None, 33)
    check("a missing frame holds the last position", held == (0.4, 0.6), str(held))


def test_smoother_rejects_an_impossible_jump() -> None:
    """One glitched frame must not teleport the cursor across the screen."""
    smoother = PointerSmoother(alpha=1.0, max_jump=0.33)
    smoother.update((0.2, 0.2), 0)
    after = smoother.update((0.95, 0.95), 33)
    check("a wild jump is ignored", after == (0.2, 0.2), str(after))


def test_smoother_accepts_real_movement() -> None:
    """A normal move must still be followed."""
    smoother = PointerSmoother(alpha=1.0, max_jump=0.33)
    smoother.update((0.2, 0.2), 0)
    after = smoother.update((0.3, 0.25), 33)
    check("a normal move is followed", after == (0.3, 0.25), str(after))


def test_smoother_is_frame_rate_independent() -> None:
    """The same elapsed time must ease the same amount at 12 fps and 30 fps."""
    fast = PointerSmoother(alpha=0.45)
    slow = PointerSmoother(alpha=0.45)
    fast.update((0.0, 0.0), 0)
    slow.update((0.0, 0.0), 0)
    # 30 fps: three 33 ms steps. 12 fps: one 100 ms step.
    for t in (33, 66, 100):
        fast.update((1.0, 0.0), t)
    slow.update((1.0, 0.0), 100)
    assert fast.value and slow.value
    check(
        "smoothing does not depend on frame rate",
        abs(fast.value[0] - slow.value[0]) < 0.02,
        f"{fast.value[0]:.3f} vs {slow.value[0]:.3f}",
    )


def test_smoother_snaps_after_a_long_gap() -> None:
    """After tracking was lost, the cursor must not crawl back from the old spot."""
    smoother = PointerSmoother(alpha=0.45, max_gap_ms=250)
    smoother.update((0.1, 0.1), 0)
    after = smoother.update((0.6, 0.6), 1000)
    check("a long gap snaps to the new position", after == (0.6, 0.6), str(after))


def test_a_pinch_clicks_even_when_the_hand_reads_as_a_fist() -> None:
    """Pinching must press the button, not start a grab.

    Touching thumb to index curls the fingers, so a pinching hand is a fist to
    `finger_curl` — a relaxed open hand already scores ~0.72 against a 0.55
    threshold. The dispatcher used to check `in_front` first and return, so every
    pinch went into the grab path and `pointer.press` was never emitted.
    """
    assert finger_curl(make_fist(Point(0.5, 0.1), closed=True)) >= 0.55

    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=60))
    machine.arm(0)
    events = []
    t = 0
    for _ in range(20):
        # A hand held out in front (inside the grab band) that is also pinching.
        events.extend(feed(machine, t, in_front=True, distance=1.6, curl=0.8, pointer=(0.5, 0.5), pinching=True))
        t += 33
    kinds = [e.kind for e in events]
    check("a pinch in the grab band still presses", kinds.count("pointer.press") == 1, str(kinds))
    check("a pinch does not also grab", kinds.count("window.grab") == 0, str(kinds))


def test_detect_fist_vetoes_a_pinch() -> None:
    """The geometry layer must not call a pinching hand a fist."""
    hand = make_fist(Point(0.5, 0.1), closed=True)
    face = make_face()
    without = detect_fist(hand, face)
    with_pinch = detect_fist(hand, face, pinching=True)
    check("a curled hand alone is a grab candidate", without.in_front, without.reason)
    check("pinching vetoes the grab", not with_pinch.in_front, with_pinch.reason)
    check("a pinching hand is still reported visible", with_pinch.hand_visible, "hand hidden")


def test_a_real_fist_still_grabs() -> None:
    """The pinch veto must not stop an actual fist from grabbing."""
    reading = detect_fist(make_fist(Point(0.5, 0.1), closed=True), make_face(), pinching=False)
    check("an outstretched fist still grabs", reading.in_front, f"d={reading.distance:.2f} {reading.reason}")


def test_pinch_uses_two_thresholds() -> None:
    """Closing needs a tighter pinch than staying closed: that is the hysteresis."""
    near = make_pointing_hand(0.5, 0.5, pinched=True)
    # From open, a borderline pinch does not press.
    opening = detect_pointer(near, pinch_on=0.2, pinch_off=0.9, was_pinching=False)
    # From pinched, the same position stays pressed.
    closing = detect_pointer(near, pinch_on=0.2, pinch_off=0.9, was_pinching=True)
    check("a borderline pinch does not start from open", not opening.pinch, f"d={opening.pinch_distance:.2f}")
    check("a borderline pinch stays held once closed", closing.pinch, f"d={closing.pinch_distance:.2f}")


def test_open_hand_is_not_a_pinch() -> None:
    reading = detect_pointer(make_pointing_hand(0.5, 0.5, pinched=False))
    check("an open hand is not pinching", not reading.pinch, f"d={reading.pinch_distance:.2f}")


def test_fist_is_not_a_pinch() -> None:
    """A fist rests the thumb beside the curled index tip; that is a grab, not a click."""
    fist = make_fist(Point(0.5, 0.5), closed=True)
    fist[HAND_THUMB_TIP] = Point(fist[HAND_INDEX_TIP].x + 0.005, fist[HAND_INDEX_TIP].y + 0.005)
    reading = detect_pointer(fist)
    check(
        "a fist is not a pinch",
        not reading.pinch,
        f"d={reading.pinch_distance:.2f} curl={finger_curl(fist):.2f}",
    )


def test_pinch_distance_is_size_independent() -> None:
    small = make_pointing_hand(0.5, 0.5, pinched=True)
    large = [Point(p.x * 2, p.y * 2) for p in small]
    a = pinch_distance(small)
    b = pinch_distance(large)
    check("pinch distance does not depend on hand size", abs(a - b) < 1e-6, f"{a:.3f} vs {b:.3f}")


def test_a_natural_pinch_is_not_vetoed_by_curled_other_fingers() -> None:
    """The reported bug: a real pinch did not click.

    Touching thumb to index curls the index, and people often curl the middle
    finger with it. Averaging all four can then cross the 0.55 fist gate even
    though ring and pinky are relaxed, so `detect_pointer` returned "fist" and
    the press never fired. The grab decision must ignore the index and require
    the other three fingers to be closed.
    """
    hand = make_anatomical_hand(Point(0.5, 0.5), curled=False, pinching=True)
    # Middle follows the pinch, ring is half-curled, pinky relaxed. This is the
    # pose that used to average above the gate.
    for tip_index, pip_index, mcp_index, span in (
        (12, 10, 9, 0.0495),   # middle: curl ~0.80
        (16, 14, 13, 0.0633),  # ring:   curl ~0.60
        (20, 18, 17, 0.0736),  # pinky:  curl ~0.45
    ):
        mcp = hand[mcp_index]
        hand[tip_index] = Point(mcp.x, mcp.y - span)

    average = finger_curl(hand)
    reading = detect_pointer(hand)
    check(
        "the old average gate would have called this hand a fist",
        average >= 0.55,
        f"avg={average:.2f} fingers={[round(c, 2) for c in finger_curls(hand)]}",
    )
    check(
        "a natural pinch is not a grabbing fist",
        not fist_pose(hand),
        f"fingers={[round(c, 2) for c in finger_curls(hand)]}",
    )
    check("a natural pinch still presses", reading.pinch, f"d={reading.pinch_distance:.2f} {reading.reason}")


def test_world_landmarks_recover_a_fist_hidden_by_projection() -> None:
    """A real fist can vanish in the 2D projection; the metric 3D data saves it.

    This is the reported bug: a fully balled fist was not recognised. When the
    hand is edge-on, the 2D MCP-to-PIP bone collapses to nothing and the curl
    cannot be measured at all. MediaPipe's world landmarks are rotation
    invariant, so the same pose is still unambiguously a fist there.
    """
    anatomical = make_anatomical_hand(Point(0.5, 0.75), curled=True)
    # Project the hand onto a line (all y equal) as an edge-on view would.
    projected = [Point(p.x, 0.0) for p in anatomical]
    # Rotate the same points about x so the useful length is now on z.
    world = [Point(p.x, 0.0, p.y) for p in anatomical]

    check("2D cannot measure an edge-on fist", finger_curls(projected) == [], str(finger_curls(projected)))
    check("3D still measures all four fingers", len(finger_curls_3d(world)) == 4, str(finger_curls_3d(world)))
    check(
        "a 3D fist is recognised despite the flat projection",
        fist_pose(projected, world_hand=world),
        str([round(c, 2) for c in finger_curls_3d(world)]),
    )
    check("the same flat projection without 3D is not trusted", not fist_pose(projected))


def test_three_finger_pinch_is_the_scroll_gesture() -> None:
    """Thumb + index + middle is a scroll, not a click and not a fist."""
    hand = make_scroll_hand()
    check(
        "thumb, index and middle together are a scroll",
        three_finger_pinch(hand),
        f"middle={middle_pinch_distance(hand):.2f} curls={[round(c, 2) for c in finger_curls(hand)]}",
    )
    reading = detect_pointer(hand)
    check("a scroll is reported as scrolling", reading.scrolling, reading.reason)
    check("a scroll never also clicks", not reading.pinch, reading.reason)

    two = make_pointing_hand(0.5, 0.5, pinched=True)
    check("a two-finger pinch is not a scroll", not three_finger_pinch(two))
    check("a two-finger pinch still clicks", detect_pointer(two).pinch)


def test_closed_ring_or_pinky_is_not_a_scroll() -> None:
    """Two open fingers are what separate a scroll from a fist.

    In a fist the thumb naturally rests beside the curled index and middle, so
    distance alone would call it a three-finger pinch. Requiring the outer two
    fingers to stay open is the discriminator.
    """
    check("a clenched ring is not a scroll", not three_finger_pinch(make_scroll_hand(ring_open=False)))
    check("a clenched pinky is not a scroll", not three_finger_pinch(make_scroll_hand(pinky_open=False)))
    fist = make_anatomical_hand(Point(0.5, 0.5), curled=True)
    check("a full fist is not a scroll", not three_finger_pinch(fist))


def test_pose_metrics_separate_a_tucked_thumb_from_a_reaching_one() -> None:
    """The numbers that must tell this user's fist from their scroll pose.

    Curl cannot do it: a live fist reports the ring and pinky near 0.56-0.67 and
    a live scroll pose reports almost the same, so the fist kept scrolling the
    page instead of grabbing a window. Reach can: a fist tucks the thumb across
    the fingers while a scroll extends it to the index and middle tips.
    """
    reaching = make_anatomical_hand(Point(0.5, 0.5))
    index_tip = reaching[HAND_INDEX_TIP]
    reaching[HAND_THUMB_TIP] = Point(index_tip.x, index_tip.y)
    far = pose_metrics(reaching)
    check("a hand reaching out reports a long thumb reach", far["thumbReach"] > 1.0, str(far))

    tucked = make_anatomical_hand(Point(0.5, 0.5))
    wrist = tucked[HAND_WRIST]
    tucked[HAND_THUMB_TIP] = Point(wrist.x + 0.015, wrist.y - 0.02)
    near = pose_metrics(tucked)
    check(
        "a tucked thumb measures a clearly shorter reach",
        near["thumbReach"] < far["thumbReach"] - 0.3,
        f"tucked={near['thumbReach']} reaching={far['thumbReach']}",
    )


def test_pose_metrics_are_size_independent() -> None:
    """The same pose must measure the same close to the camera and far away."""
    hand = make_anatomical_hand(Point(0.5, 0.5))
    near = pose_metrics(hand)
    half = [Point(0.5 + (p.x - 0.5) * 0.5, 0.5 + (p.y - 0.5) * 0.5) for p in hand]
    far = pose_metrics(half)
    for key in ("thumbReach", "indexSpan", "middleSpan"):
        check(
            f"{key} is unchanged by distance",
            abs(near[key] - far[key]) < 1e-6,
            f"near={near[key]} far={far[key]}",
        )
    check("an incomplete hand reports no metrics", pose_metrics(hand[:4]) == {})


def test_a_fist_with_the_thumb_beside_the_index_is_not_a_scroll() -> None:
    """The live defect: a fist passed every gate the scroll pose passes.

    From the recorded frames, a held fist put the thumb within 0.5 hand-widths
    of both the index and middle tips, with ring and pinky curls of 0.52-0.66 —
    all inside the old gates. The only measurement that differs is the index
    itself: a fist folds it (curl 0.57-0.74, tip-to-knuckle span ~0.5) while a
    scroll reaches with it (curl ~0.1, span ~1.0).
    """
    hand = make_anatomical_hand(Point(0.5, 0.5), curled=False)
    # Fold index and middle into the palm, as a fist does.
    for mcp_i, tip_i in ((HAND_INDEX_MCP, HAND_INDEX_TIP), (HAND_MIDDLE_MCP, HAND_MIDDLE_TIP)):
        mcp = hand[mcp_i]
        hand[tip_i] = Point(mcp.x, mcp.y + 0.02)
    # Thumb resting across both curled fingertips.
    hand[HAND_THUMB_TIP] = Point(hand[HAND_INDEX_TIP].x - 0.004, hand[HAND_INDEX_TIP].y - 0.004)
    hand[HAND_MIDDLE_TIP] = Point(hand[HAND_THUMB_TIP].x + 0.005, hand[HAND_THUMB_TIP].y + 0.005)

    curls = finger_curls(hand)
    detail = (
        f"pd={pinch_distance(hand):.2f} md={middle_pinch_distance(hand):.2f} "
        f"curls={[round(c, 2) for c in curls]} spans={pose_metrics(hand)}"
    )
    check("the thumb is close enough to look like a pinch", pinch_distance(hand) < 0.5, detail)
    check("the middle is close enough to look pinched too", middle_pinch_distance(hand) < 0.5, detail)
    check("ring and pinky would pass the open-finger gate", curls[2] < 0.75 and curls[3] < 0.75, detail)
    check("a fist is not a three-finger scroll", not three_finger_pinch(hand), detail)
    reading = detect_pointer(hand)
    check("a fist never reports scrolling", not reading.scrolling, reading.reason)


def test_a_two_finger_click_is_not_a_scroll() -> None:
    """The live false positive: the index touches the thumb, the middle is near.

    The old gate allowed the middle anywhere within `pinch_on + margin` (0.60),
    so a two-finger click whose extended middle sat around 0.50 was read as a
    scroll. The wheel then owned the frame, froze the cursor, and the scroll
    state stuck for seconds while the user was only trying to click.
    """
    hand = make_pointing_hand(0.5, 0.5, pinched=True)
    thumb = hand[HAND_THUMB_TIP]
    # Middle tip 0.03 from the thumb: 0.50 hand-widths on this fixture. Inside
    # the old absolute gate, clearly farther than the pinched index (0.24).
    hand[HAND_MIDDLE_TIP] = Point(thumb.x + 0.03, thumb.y)
    curls = finger_curls(hand)
    detail = (
        f"index={pinch_distance(hand):.2f} middle={middle_pinch_distance(hand):.2f} "
        f"curls={[round(c, 2) for c in curls]}"
    )
    check("the middle is within the old absolute gate", middle_pinch_distance(hand) <= 0.60, detail)
    check("a two-finger click is not a scroll", not three_finger_pinch(hand), detail)
    reading = detect_pointer(hand)
    check("a two-finger click still clicks", reading.pinch and not reading.scrolling, reading.reason)


def test_a_landmark_jump_does_not_spin_the_wheel() -> None:
    """One wild frame must not become a burst of wheel notches.

    The live log showed alternating +3/-3 notches because raw hand position was
    jumping across the frame between frames.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    events = feed(machine, 33, pointer=(0.5, 0.10), scrolling=True)
    check(
        "a 40% jump in one frame produces no wheel",
        not [e for e in events if e.kind == "pointer.scroll"],
        str([e.kind for e in events]),
    )
    # The discarded jump leaves the accumulator at the new position. Ordinary
    # travel from there must scroll normally; one notch now costs 0.10, so the
    # recovery is measured over a realistic sweep rather than a single nudge.
    events = feed(machine, 66, pointer=(0.5, 0.02), scrolling=True)
    events += feed(machine, 99, pointer=(0.5, -0.02), scrolling=True)
    events += feed(machine, 132, pointer=(0.5, -0.12), scrolling=True)
    check(
        "scrolling resumes from the rebaselined position",
        bool([e for e in events if e.kind == "pointer.scroll"]),
        str([e.kind for e in events]),
    )


def test_the_end_of_a_scroll_does_not_click() -> None:
    """Dropping the middle finger must not press the button on the way out."""
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    feed(machine, 33, pointer=(0.5, 0.46), scrolling=True)
    events = feed(machine, 66, pointer=(0.5, 0.46), scrolling=False, pinching=True)
    check(
        "ending a scroll does not fall straight into a click",
        not [e for e in events if e.kind == "pointer.press"],
        str([e.kind for e in events]),
    )


def test_scroll_follows_the_hand_like_dragging_the_page() -> None:
    """Vertical hand travel becomes wheel notches, accumulated across frames.

    The page follows the hand: move the hand up and the content moves up with
    it. In Windows that is a negative wheel delta. The first mapping turned the
    wheel the other way, which the user immediately reported as inverted.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    first = feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    check("the first scroll frame is a baseline", not [e for e in first if e.kind == 'pointer.scroll'])

    # The arming frame becomes the wheel's baseline, so the notch arrives on the
    # next frame of travel. A real sweep spans several frames at 30 fps.
    events = feed(machine, 33, pointer=(0.5, 0.38), scrolling=True)
    events += feed(machine, 66, pointer=(0.5, 0.26), scrolling=True)
    notches = [e.detail.get('notches') for e in events if e.kind == 'pointer.scroll']
    check("moving the hand up pushes the content up", notches and notches[0] < 0, str(notches))

    down = MouthGestureMachine()
    down.arm(0)
    feed(down, 0, pointer=(0.5, 0.40), scrolling=True)
    events = feed(down, 33, pointer=(0.5, 0.52), scrolling=True)
    events += feed(down, 66, pointer=(0.5, 0.64), scrolling=True)
    notches = [e.detail.get('notches') for e in events if e.kind == 'pointer.scroll']
    check("moving the hand down pushes the content down", notches and notches[0] > 0, str(notches))


def test_a_slow_frame_rate_still_scrolls() -> None:
    """A dropped frame must not throw the sweep away.

    Under load the service drops to 5-10 fps, so one frame can cover 12% of the
    screen height. The old guard compared that per-frame distance against a
    fixed 10% cap and discarded the frame, which is why the page moved about
    once a second. The guard now measures speed instead.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    events = feed(machine, 200, pointer=(0.5, 0.38), scrolling=True)
    notches = [e.detail["notches"] for e in events if e.kind == "pointer.scroll"]
    check("a 12% move across a 200 ms frame still scrolls", bool(notches), str(notches))


def test_a_capped_frame_keeps_the_rest_of_the_sweep() -> None:
    """The per-frame cap must not discard travel the hand really made.

    Clamping a burst is right, but subtracting nothing returned the lost
    notches to the accumulator, so one fast sweep emitted a single capped burst
    and then stopped even though the hand kept moving.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.90), scrolling=True)
    first = feed(machine, 200, pointer=(0.5, 0.55), scrolling=True)
    notches = [e.detail["notches"] for e in first if e.kind == "pointer.scroll"]
    check("the burst is capped", notches == [-3], str(notches))

    moved = feed(machine, 400, pointer=(0.5, 0.50), scrolling=True)
    more = [e.detail["notches"] for e in moved if e.kind == "pointer.scroll"]
    check("the travel the cap held back still arrives", bool(more), str(more))


def test_a_held_fist_grabs_instead_of_scrolling() -> None:
    """The live bug: a fist held up to grab turned the wheel instead.

    A real fist and the three-finger scroll curl the ring and pinky to nearly
    the same values, so the pose was accepted as a scroll on every frame and the
    grab branch below it never ran. A hand that stays put is a fist.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    events = []
    for t in range(0, 900, 33):
        events += feed(machine, t, in_front=True, pointer=(0.5, 0.5), scrolling=True)
    check("a still fist does not arm the wheel", not machine.scroll_armed)
    check(
        "a still fist never turns the wheel",
        not [e for e in events if e.kind == "pointer.scroll"],
        str([e.kind for e in events]),
    )
    check(
        "a held fist still grabs the window",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )


def test_a_deliberate_sweep_arms_the_wheel() -> None:
    """Movement is what makes a closed hand a wheel rather than a fist."""
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, in_front=True, pointer=(0.5, 0.50), scrolling=True)
    # 0.12 of travel: one notch now costs 0.10, so a deliberate sweep has to be
    # a real sweep. This is the point of the reduced sensitivity.
    events = feed(machine, 60, in_front=True, pointer=(0.5, 0.38), scrolling=True)
    notches = [e.detail["notches"] for e in events if e.kind == "pointer.scroll"]
    check("a deliberate sweep turns the wheel", bool(notches), str(notches))
    check("the sweep armed the wheel", machine.scroll_armed)

    held = []
    for t in range(120, 900, 33):
        held += feed(machine, t, in_front=True, pointer=(0.5, 0.42), scrolling=True)
    check(
        "an armed wheel does not grab the window",
        not [e for e in held if e.kind == "window.grab"],
        str([e.kind for e in held]),
    )


def test_a_fist_that_drifts_while_forming_still_grabs() -> None:
    """Forming a fist moves the hand; that must not turn it into a wheel.

    Reported as: "when I try to grab a window by putting my fist in front, it
    detects it as a scroll motion not a grab window motion". Reaching forward and
    closing the hand produces a little travel, and the wheel armed on it, so the
    grab branch never ran. Arming now needs a real sweep (`scroll_arm_distance`),
    and ordinary settling stays well under that.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # Reaching in and closing the hand: a few frames of small movement that
    # settle. Every frame reports the scroll *pose*, because a fist and a scroll
    # pose are genuinely the same shape.
    drift = [(0, 0.62), (33, 0.60), (66, 0.585), (99, 0.578), (132, 0.575)]
    events: list = []
    for t, y in drift:
        events += feed(machine, t, in_front=True, distance=1.6, pointer=(0.5, y), scrolling=True)

    check("a drifting fist does not arm the wheel", not machine.scroll_armed)
    check(
        "a drifting fist does not scroll the page",
        not [e for e in events if e.kind == "pointer.scroll"],
        str([e.kind for e in events]),
    )

    # Held in front, the fist is a grab.
    for t in range(165, 900, 33):
        events += feed(machine, t, in_front=True, distance=1.6, pointer=(0.5, 0.575), scrolling=True)
    check(
        "the drifting fist still grabs the window",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )


def test_the_left_hand_switches_desktops_with_no_right_hand_in_frame() -> None:
    """Bug: the left-hand swipe only worked while the right hand was visible.

    Reported as: "when I try to move a window, the left hand does not work unless
    my right hand is visible". The desktop swipe ran *before* the tracking gate,
    and that gate requires the right hand — so with the right hand out of frame
    the machine reset every frame and the swipe anchor never accumulated travel.
    The two hands are independent gestures; one must not depend on the other.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # No right hand at all: `hand_visible` false, no pointer, no face reading.
    events: list = []
    for t, x in [(0, 0.30), (33, 0.40), (66, 0.55)]:
        events += feed(
            machine, t, in_front=False, hand=False, face=False,
            left_fist=True, left_pointer=(x, 0.5),
        )

    switched = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check("a lone left fist still switches desktops", bool(switched), str(switched))
    check("and follows the hand's direction", set(switched) == {"right"}, str(switched))
    first_count = len(switched)

    # And the other way, still with no right hand in frame. The hand is walked
    # back gradually: a single 0.25 jump reads as a tracker glitch, not a swipe.
    # Walked back a step at a time, as a real hand moves. A single 0.25 jump is
    # tracker glitch territory and is consumed as travel in its own direction.
    for t, x in [(1000, 0.63), (1100, 0.58), (1200, 0.50), (1300, 0.42), (1400, 0.34)]:
        events += feed(
            machine, t, in_front=False, hand=False, face=False,
            left_fist=True, left_pointer=(x, 0.5),
        )
    switched = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    # The tail may end with one more "right" as the remainder of the first sweep
    # is consumed; what matters is that the reverse movement switches left.
    check(
        "a lone left fist still switches back",
        "left" in switched[first_count:],
        str(switched),
    )


def test_a_relaxed_fist_is_never_read_as_a_scroll() -> None:
    """A fist must not become a wheel just because the hand is not fully closed.

    Reported: "It detects fist in front as a pinch or scroll sometimes."

    A balled fist was rejected, but a relaxed one - index folded to about 0.45,
    ring and pinky still bent just under the open threshold - passed both the
    outer-finger gate and the cup gate, so a held fist scrolled and a moving one
    swept the page. The scroll gesture reaches out with the index; a fist cannot,
    so a folded index now rejects the scroll on its own.
    """
    # A relaxed fist: the index folded to about mid-way, the outer fingers bent
    # but not closed. This is the shape a hand actually holds while waiting to
    # grab, and the band where the old gate still accepted it as a wheel.
    loose = make_partly_closed_hand(Point(0.5, 0.80))
    curls = finger_curls(loose)
    check(
        "the fixture really is a loose fist",
        curls[0] > 0.4 and max(curls[2], curls[3]) < 0.75,
        f"curls={[round(c, 2) for c in curls]}",
    )
    check("a loose fist is not a scroll", not three_finger_pinch(loose), "read as a scroll")

    # A genuine three-finger scroll must still be recognised.
    scroll = make_scroll_hand(0.5, 0.5)
    check("a real scroll still scrolls", three_finger_pinch(scroll), "a real scroll was rejected")


def test_a_window_held_by_the_grab_is_not_dropped_by_the_mouth_band() -> None:
    """A grab must survive the hand drifting into the dictation band.

    Reported: "Grabbing a window and moving it around doesn't function reliably
    either."

    A fist in front and a cupped fist at the mouth overlap in projection, so
    single frames of a moving drag land inside the mouth band. Dictation used to
    clear the grab's hold timer, which ended the grab mid-drag: the window
    stopped following the hand and the next frame needed a fresh hold.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # Hold a fist in front until the window is grabbed.
    for t in range(0, 700, 33):
        feed(machine, t, in_front=True, at_mouth=False, hand=True, face=True)
    check("the window is grabbed first", machine._grab_phase is not None, "no grab")

    # Now drag, with every third frame reading as "at mouth".
    events: list = []
    for t in range(700, 1700, 33):
        at_mouth = (t // 33) % 3 == 0
        events += feed(machine, t, in_front=True, at_mouth=at_mouth, hand=True, face=True)

    check(
        "dictation never starts from a hand already dragging",
        not [e for e in events if e.kind == "dictation.start"],
        str([e.kind for e in events]),
    )
    check(
        "the grab is still held after the drag",
        machine._grab_phase is not None,
        "the grab was dropped mid-drag",
    )


def test_a_fist_raised_then_held_grabs_instead_of_scrolling() -> None:
    """The reported bug: cupping a fist in front scrolled instead of grabbing.

    "Whenever I try to grab a window, it detects it as scrolling... It even says
    scrolling on the stat bar instead of window grab."

    The pose alone cannot separate a fist from a wheel, so arming is decided by
    travel: 5% of the frame inside 400 ms turns the pose into a wheel. Bringing
    the fist *into* position travels much more than that, so the wheel armed on
    the way up, `_scroll_armed` then suppressed the grab branch for as long as
    the pose held, and the status read "Scroll".

    A real sweep keeps moving; a fist settles and holds. An armed wheel that
    stops travelling must hand the pose back to the grab path.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # Raise the hand into the front band in the *scroll pose*: this travels, and
    # arms the wheel. The pose is what the camera reports for the user's fist.
    events: list = []
    events += feed(machine, 0, in_front=True, distance=1.6, pointer=(0.5, 0.86), scrolling=True)
    events += feed(machine, 33, in_front=True, distance=1.6, pointer=(0.5, 0.72), scrolling=True)
    events += feed(machine, 66, in_front=True, distance=1.6, pointer=(0.5, 0.58), scrolling=True)
    check("raising the fist does arm the wheel", machine.scroll_armed, "expected the raise to arm it")

    # Now hold it still, exactly as you would to grab a window.
    for t in range(99, 1500, 33):
        events += feed(machine, t, in_front=True, distance=1.6, pointer=(0.5, 0.58), scrolling=True)

    check(
        "a settled fist is no longer a wheel",
        not machine.scroll_armed,
        "the wheel stayed armed, so the grab branch never ran",
    )
    check(
        "a held fist grabs the window",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )

    # The page must not keep turning while the fist is held. Some notches during
    # the raise are unavoidable — the hand genuinely travels up into position and
    # the machine cannot know its intent yet — but once it is held still nothing
    # more may scroll, and the grab must win the pose.
    settle_at = 99 + (machine.config.grab_hold_ms // 33 + 2) * 33
    late = [e for e in events if e.kind == "pointer.scroll" and e.at_ms >= settle_at]
    check(
        "a held fist stops scrolling the page",
        not late,
        str([(e.at_ms, e.detail.get("notches")) for e in late]),
    )


def test_a_scroll_in_progress_never_clicks() -> None:
    """Bug: the wheel stuttered and started a *selection* instead.

    Reported as "sometimes instead of scrolling it selects". `detect_pointer`
    accepted `was_scrolling` but never read it, so on any frame where the third
    finger drifted off the thumb the scroll pose stopped matching and the hand
    fell through to the pinch test, which pressed the button mid-scroll.

    The fix is not "also click while scrolling"; it is that a running scroll
    suppresses the click until the wheel's own grace window expires.
    """
    hand = make_fist(Point(0.5, 0.5), closed=False)

    # A hand that is *not* in the scroll pose and would otherwise click.
    idle = detect_pointer(hand, was_scrolling=False)
    check("an idle hand still tracks", idle.hand_visible, f"reason={idle.reason}")

    sticky = detect_pointer(hand, was_scrolling=True)
    # The latch must NOT report scrolling again: doing so refreshed the caller's
    # "last seen" timestamp from its own latched value, so the wheel never ended
    # and the page kept scrolling after the hand opened.
    check(
        "a latched scroll does not report the pose again",
        not sticky.scrolling,
        f"scrolling={sticky.scrolling} — a self-refreshing latch never expires",
    )
    check(
        "a running scroll cannot press the button",
        not sticky.pinch,
        f"pinch={sticky.pinch} — a click here selects instead of scrolling",
    )


def test_a_window_drag_is_not_cancelled_by_the_scroll_pose() -> None:
    """Bug: a grabbed window stopped moving the moment the pose read as scroll.

    Reported as "moving windows does not work at all". The scroll pose and the
    fist are the same shape on a real hand, so a few drift frames flipped the
    classification and the desktop dropped every drag frame while it "scrolled".
    Once a window is physically held the drag owns the frame.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for t in range(0, 660, 33):
        events += feed(machine, t, in_front=True, distance=1.6, pointer=(0.5, 0.5))
    check(
        "the fist grabs before any scroll pose appears",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )

    # The hand now drifts into the scroll pose without leaving `in_front`.
    after = []
    for t in range(660, 1200, 33):
        after += feed(machine, t, in_front=True, distance=1.6, pointer=(0.5, 0.5), scrolling=True)
    check(
        "the held grab survives the scroll pose",
        not [e for e in after if e.kind == "window.release"],
        str([e.kind for e in after]),
    )


def test_a_continuous_left_sweep_keeps_switching_without_releasing() -> None:
    """The trackpad feel: keep moving, keep switching, never unclench.

    "It should move the desktops as I move my fist just like how it would be if I
    would just use 4 fingers on my trackpad."
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    events: list = []
    # One uninterrupted sweep: the fist is never released.
    for i in range(20):
        events += feed(machine, i * 150, left_fist=True, left_pointer=(0.20 + 0.035 * i, 0.5))

    directions = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check(
        "an unbroken sweep keeps switching",
        len(directions) >= 4,
        str(directions),
    )
    check(
        "every switch goes the way the hand went",
        set(directions) == {"right"},
        str(directions),
    )


def test_releasing_the_left_fist_reanchors_the_sweep() -> None:
    """After a release, the next sweep is measured from where the fist forms.

    Without re-anchoring, forming a fist somewhere new would immediately count the
    distance from the previous fist's last position as travel and fire switches
    the user never asked for.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # Sweep right, then release.
    for i in range(8):
        feed(machine, i * 150, left_fist=True, left_pointer=(0.30 + 0.03 * i, 0.5))
    feed(machine, 1200, left_fist=False, left_pointer=None)

    # Form a fresh fist far to the right and hold it still: no travel, no switch.
    events: list = []
    for i in range(6):
        events += feed(machine, 1400 + i * 150, left_fist=True, left_pointer=(0.85, 0.5))
    check(
        "a fresh fist held still switches nothing",
        not [e for e in events if e.kind == "desktop.switch"],
        str([e.kind for e in events]),
    )


def test_scroll_takes_more_travel_per_notch() -> None:
    """Real use showed 0.035 was too sensitive: a held hand moved the page.

    One notch now costs 10% of the screen height, so a 20% sweep is exactly two
    notches. The arming frame is the baseline, so the travel after it is what
    counts.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    events = feed(machine, 100, pointer=(0.5, 0.30), scrolling=True)
    notches = [e.detail["notches"] for e in events if e.kind == "pointer.scroll"]
    check("a 20% sweep is two notches", notches == [-2], str(notches))


def test_a_held_left_fist_walks_desktops_as_it_moves() -> None:
    """Reported: "I shouldn't have to unclench my fist."

    The fist is held and moved, and every step of sideways travel switches one
    desktop for as long as it keeps going — the same feel as sliding four fingers
    across a trackpad. No unclench between switches.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    # Hold the fist and sweep steadily right across the frame.
    events: list = []
    events += feed(machine, 0, left_fist=True, left_pointer=(0.30, 0.5))
    for i, x in enumerate([0.42, 0.54, 0.66, 0.78], start=1):
        events += feed(machine, i * 150, left_fist=True, left_pointer=(x, 0.5))

    directions = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check(
        "a held fist keeps switching as it moves",
        len(directions) >= 3,
        str(directions),
    )
    check("every switch follows the hand", set(directions) == {"right"}, str(directions))

    # Sweeping back the other way, still without releasing the fist.
    back: list = []
    for i, x in enumerate([0.66, 0.54, 0.42], start=10):
        back += feed(machine, i * 150, left_fist=True, left_pointer=(x, 0.5))
    directions = [e.detail["direction"] for e in back if e.kind == "desktop.switch"]
    check(
        "reversing the hand reverses the switches",
        bool(directions) and set(directions) == {"left"},
        str(directions),
    )


def test_holding_a_still_left_fist_switches_nothing() -> None:
    """Holding still must not repeat, or the desktops would run away."""
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for t in range(0, 1500, 33):
        events += feed(machine, t, left_fist=True, left_pointer=(0.5, 0.5))
    check(
        "a still fist switches nothing",
        not [e for e in events if e.kind == "desktop.switch"],
        str([e.kind for e in events]),
    )


def test_a_short_nudge_does_not_switch_a_desktop() -> None:
    """One small movement must not equal one desktop.

    Reported: "one step should not equal to one desktop... it should slowly move
    the thing in that direction until it eventually reaches the next desktop...
    Not a sudden jerk".

    A nudge shorter than a whole step only builds progress; nothing switches.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for i, x in enumerate([0.50, 0.52, 0.55, 0.57]):
        events += feed(machine, i * 33, left_fist=True, left_pointer=(x, 0.5))

    check(
        "a short nudge switches nothing",
        not [e for e in events if e.kind == "desktop.switch"],
        str([e.kind for e in events]),
    )
    check(
        "but the travel is remembered as progress",
        0.3 < abs(machine._desk_progress) < 1.0,
        f"progress={machine._desk_progress:.2f}",
    )


def test_sliding_past_a_full_step_commits_exactly_one_desktop() -> None:
    """Continuing the slide eventually reaches the next desktop — once."""
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for i in range(16):
        events += feed(machine, i * 33, left_fist=True, left_pointer=(0.50 + 0.015 * i, 0.5))

    directions = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check(
        "a slide of just over one step commits one desktop",
        directions == ["right"],
        str(directions),
    )


def test_reversing_mid_slide_cancels_the_progress() -> None:
    """The slide must follow the hand, so turning around starts over.

    Without this, a hand that built 90% of a step to the right and then reversed
    would still commit that rightward desktop as it moved left.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, left_fist=True, left_pointer=(0.50, 0.5))
    feed(machine, 33, left_fist=True, left_pointer=(0.60, 0.5))
    forward_progress = machine._desk_progress
    check("progress built going right", forward_progress > 0.5, f"{forward_progress:.2f}")

    events = feed(machine, 66, left_fist=True, left_pointer=(0.52, 0.5))
    check(
        "reversing switches nothing on the way past",
        not [e for e in events if e.kind == "desktop.switch"],
        str([e.kind for e in events]),
    )
    # The banked rightward progress is discarded and the slide restarts from the
    # turn-around point, so nothing carries over into a desktop it left behind.
    check(
        "reversing resets the progress",
        abs(machine._desk_progress) < forward_progress,
        f"progress={machine._desk_progress:.2f} (was {forward_progress:.2f})",
    )


def test_the_desktop_sweep_carries_partial_travel_between_frames() -> None:
    """Slow movement must add up instead of being thrown away each frame.

    The anchor advances by exactly the travel consumed, so a hand moving less than
    one step per frame still eventually crosses a step. Without that, slow sweeps
    never switched at all.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    # 0.02 per frame against a 0.12 step: six frames per desktop.
    for i in range(30):
        events += feed(machine, i * 150, left_fist=True, left_pointer=(0.30 + 0.02 * i, 0.5))
    directions = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check(
        "a slow steady sweep still switches",
        len(directions) >= 3,
        str(directions),
    )
    check("and in the right direction", set(directions) == {"right"}, str(directions))


def test_a_left_fist_never_moves_the_cursor() -> None:
    """The left hand may switch desktops; it may never touch the pointer."""
    machine = MouthGestureMachine()
    machine.arm(0)
    events = []
    for t in range(0, 600, 33):
        events += feed(machine, t, left_fist=True, left_pointer=(0.4 + t / 4000.0, 0.5))
    check("the left hand leaves the pointer alone", machine.pointer is None)
    check(
        "the left hand fires no pointer event",
        not [e for e in events if e.kind.startswith("pointer.")],
        str([e.kind for e in events]),
    )


def test_desktop_switching_needs_an_armed_machine() -> None:
    """A disarmed machine must not switch desktops behind the user's back."""
    machine = MouthGestureMachine()
    events = []
    for t in range(0, 400, 33):
        events += feed(machine, t, left_fist=True, left_pointer=(0.2 + t / 1000.0, 0.5))
    check(
        "a disarmed machine never switches desktops",
        not [e for e in events if e.kind == "desktop.switch"],
        str([e.kind for e in events]),
    )


def test_scroll_survives_a_flicker_frame() -> None:
    """A one-frame pose dropout must not throw away scroll progress.

    The accumulator only crosses a notch after several frames of travel. Ending
    the stream on the first miss reset the baseline and the remainder, so a real
    hand sweep produced no wheel event at all — the reported "scrolling does
    nothing" bug.
    """
    machine = MouthGestureMachine()
    machine.arm(0)

    feed(machine, 0, pointer=(0.5, 0.50), scrolling=True)
    feed(machine, 33, pointer=(0.5, 0.49), scrolling=True)
    # One frame where the pose is briefly read as a normal point.
    feed(machine, 50, pointer=(0.5, 0.49), scrolling=False)
    events = feed(machine, 66, pointer=(0.5, 0.36), scrolling=True)
    notches = [e.detail.get('notches') for e in events if e.kind == 'pointer.scroll']
    check("a dropped scroll frame does not reset the wheel", bool(notches), str(notches))

    # After the grace period the stream really does end, so the next pinch starts
    # a fresh baseline instead of inheriting stale travel.
    feed(machine, 600, pointer=(0.5, 0.44), scrolling=False)
    check("the scroll stream ends after the grace period", not machine.scrolling)


def test_pinch_presses_within_one_frame() -> None:
    """The click must not make the user wait: one 30 fps frame is enough.

    The reported bug was having to hold the pinch for what felt like a second.
    The settle window exists only to reject a finger brushing past the thumb.
    """
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.5), pinching=True)
    events = feed(machine, 34, pointer=(0.5, 0.5), pinching=True)
    check("a pinch presses on the next frame", any(e.kind == 'pointer.press' for e in events),
          str([e.kind for e in events]))


def test_scroll_suppresses_the_click() -> None:
    """Adding the middle finger must release a held click before scrolling."""
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.5, 0.5), pinching=True)
    pressed = feed(machine, 100, pointer=(0.5, 0.5), pinching=True)
    check("the pinch pressed first", any(e.kind == 'pointer.press' for e in pressed))

    events = feed(machine, 140, pointer=(0.5, 0.5), scrolling=True)
    kinds = [e.kind for e in events]
    check("scrolling releases the held click", 'pointer.release' in kinds, str(kinds))
    check("scrolling does not press again", 'pointer.press' not in kinds, str(kinds))
    check("scrolling is not treated as a grab", not any(e.kind == 'window.grab' for e in events), str(kinds))


def test_a_real_fist_is_still_a_fist_for_the_pinch_gate() -> None:
    """Relaxing the gate must not let a closed hand click."""
    hand = make_anatomical_hand(Point(0.5, 0.5), curled=True)
    hand[HAND_THUMB_TIP] = Point(hand[HAND_INDEX_TIP].x - 0.005, hand[HAND_INDEX_TIP].y - 0.005)
    reading = detect_pointer(hand)
    check("a real fist is a fist", fist_pose(hand), str([round(c, 2) for c in finger_curls(hand)]))
    check("a real fist is not a pinch", not reading.pinch, f"d={reading.pinch_distance:.2f} {reading.reason}")


def test_one_weak_finger_does_not_lose_the_fist() -> None:
    """Two of the three gripping fingers is a fist; the median decides.

    A real fist is often reported with one finger partly open — most often the
    pinky, which hides behind the palm in a balled hand. Requiring all three made
    the grab fail on those frames even though the hand was unmistakably closed.
    The median still needs two closed fingers, so a pinch (middle curled, ring
    and pinky open) cannot cross the gate.
    """
    hand = make_anatomical_hand(Point(0.5, 0.5), curled=True)
    mcp = hand[HAND_PINKY_MCP]
    hand[HAND_PINKY_TIP] = Point(mcp.x, mcp.y - 0.07)
    curls = [round(c, 2) for c in finger_curls(hand)]
    check("a fist survives a half-open pinky", fist_pose(hand), str(curls))
    check("that pinky really is below the gate", curls[3] < 0.55, str(curls))

    only_middle = make_anatomical_hand(Point(0.5, 0.5), curled=False)
    middle_mcp = only_middle[HAND_MIDDLE_MCP]
    only_middle[HAND_MIDDLE_TIP] = Point(middle_mcp.x, middle_mcp.y + 0.02)
    curls = [round(c, 2) for c in finger_curls(only_middle)]
    check("one curled finger is not a fist", not fist_pose(only_middle), str(curls))


# ---------------------------------------------------------------------------
# Throw
# ---------------------------------------------------------------------------

def test_throw_detects_a_fast_flick() -> None:
    tracker = ThrowTracker()
    for i in range(10):
        tracker.observe(i * 20, 0.2 + i * 0.06, 0.5, True)
    direction, speed = tracker.direction(180)
    check("a fast rightward flick is a throw", direction is ThrowDirection.RIGHT, direction.value)
    check("the flick is reported as fast", speed > 1.0, f"speed={speed:.2f}")


def test_slow_movement_is_not_a_throw() -> None:
    tracker = ThrowTracker()
    for i in range(10):
        tracker.observe(i * 20, 0.5 + i * 0.002, 0.5, True)
    direction, _ = tracker.direction(180)
    check("moving the hand slowly is not a throw", direction is ThrowDirection.NONE, direction.value)


def test_diagonal_movement_has_no_direction() -> None:
    tracker = ThrowTracker()
    for i in range(10):
        tracker.observe(i * 20, 0.5 + i * 0.05, 0.5 + i * 0.05, True)
    direction, _ = tracker.direction(180)
    check("a diagonal flick is ambiguous, so it is ignored", direction is ThrowDirection.NONE, direction.value)


def test_vertical_throws_are_recognised() -> None:
    tracker = ThrowTracker()
    for i in range(10):
        tracker.observe(i * 20, 0.5, 0.7 - i * 0.05, True)
    check("an upward flick is a throw", tracker.direction(180)[0] is ThrowDirection.UP)


def test_throw_needs_recent_movement() -> None:
    """Old samples must not keep reporting a direction forever."""
    tracker = ThrowTracker()
    for i in range(10):
        tracker.observe(i * 20, 0.2 + i * 0.06, 0.5, True)
    direction, speed = tracker.direction(5000)
    check("stale movement is not a throw", direction is ThrowDirection.NONE and speed == 0.0)


# ---------------------------------------------------------------------------
# State machine: pinch and throw
# ---------------------------------------------------------------------------

def test_pinch_after_settle_presses_and_holds_once() -> None:
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=60))
    machine.arm(0)
    events = []
    for t in range(0, 400, 20):
        events.extend(feed(machine, t, pointer=(0.5, 0.5), pinching=True))
    presses = [e for e in events if e.kind == "pointer.press"]
    releases = [e for e in events if e.kind == "pointer.release"]
    check("a held pinch presses exactly once", len(presses) == 1, f"presses={len(presses)}")
    check("a held pinch keeps the button down", not releases, f"releases={len(releases)}")


def test_opening_the_pinch_releases_the_button() -> None:
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=40))
    machine.arm(0)
    events = []
    for t in range(0, 120, 20):
        events.extend(feed(machine, t, pointer=(0.5, 0.5), pinching=True))
    events.extend(feed(machine, 140, pointer=(0.5, 0.5), pinching=False))
    presses = [e for e in events if e.kind == "pointer.press"]
    releases = [e for e in events if e.kind == "pointer.release"]
    check("opening the fingers presses once", len(presses) == 1, f"presses={len(presses)}")
    check("opening the fingers releases once", len(releases) == 1, f"releases={len(releases)}")
    check(
        "the release carries the pointer position",
        releases and (releases[0].detail.get("x"), releases[0].detail.get("y")) == (0.5, 0.5),
        str(releases[0].detail if releases else None),
    )


def test_brief_pinch_does_not_click() -> None:
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=200))
    machine.arm(0)
    events = []
    events.extend(feed(machine, 0, pointer=(0.5, 0.5), pinching=True))
    events.extend(feed(machine, 60, pointer=(0.5, 0.5), pinching=False))
    check("a passing pinch does not press", not any(e.kind == "pointer.press" for e in events))


def test_opening_and_closing_presses_again() -> None:
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=40))
    machine.arm(0)
    events = []
    t = 0
    for _ in range(2):
        for _ in range(5):
            events.extend(feed(machine, t, pointer=(0.5, 0.5), pinching=True))
            t += 20
        for _ in range(2):
            events.extend(feed(machine, t, pointer=(0.5, 0.5), pinching=False))
            t += 20
    presses = [e for e in events if e.kind == "pointer.press"]
    releases = [e for e in events if e.kind == "pointer.release"]
    check("two separate pinches press twice", len(presses) == 2, f"presses={len(presses)}")
    check("two separate pinches release twice", len(releases) == 2, f"releases={len(releases)}")


def test_lost_hand_releases_a_held_pinch() -> None:
    """A dropped hand must never leave the desktop stuck in a drag."""
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=40))
    machine.arm(0)
    events = []
    for t in range(0, 100, 20):
        events.extend(feed(machine, t, pointer=(0.4, 0.6), pinching=True))
    events.extend(feed(machine, 120, pointer=None, pinching=False, hand=False))
    releases = [e for e in events if e.kind == "pointer.release"]
    check("losing the hand releases the button", len(releases) == 1, f"releases={len(releases)}")
    check(
        "the safety release uses the last known position",
        releases and releases[0].detail.get("x") == 0.4,
        str(releases[0].detail if releases else None),
    )


def test_disarm_releases_a_held_pinch() -> None:
    machine = MouthGestureMachine(GestureConfig(pinch_settle_ms=40))
    machine.arm(0)
    for t in range(0, 100, 20):
        feed(machine, t, pointer=(0.5, 0.5), pinching=True)
    events = machine.disarm(100)
    releases = [e for e in events if e.kind == "pointer.release"]
    check("disarming releases the button", len(releases) == 1, f"releases={len(releases)}")


def test_pointer_updates_without_a_face() -> None:
    """Aiming does not require the face, only the hand."""
    machine = MouthGestureMachine()
    machine.arm(0)
    feed(machine, 0, pointer=(0.25, 0.75), pinching=False, face=False)
    check("pointer is tracked even with no face", machine.pointer == (0.25, 0.75), str(machine.pointer))


def test_slow_release_is_not_a_throw() -> None:
    machine = MouthGestureMachine(GestureConfig(throw_min_speed=0.9))
    machine.arm(0)
    events = machine.throw(0, "right", 0.2)
    check("releasing slowly throws nothing", not any(e.kind == "window.throw" for e in events))


def test_fast_release_throws() -> None:
    machine = MouthGestureMachine(GestureConfig(throw_min_speed=0.9))
    machine.arm(0)
    events = machine.throw(0, "left", 2.5)
    check("a fast release throws", any(e.kind == "window.throw" for e in events))
    check(
        "the throw records its direction",
        any(e.detail.get("direction") == "left" for e in events),
        str([e.detail for e in events]),
    )


def test_no_direction_never_throws() -> None:
    machine = MouthGestureMachine()
    machine.arm(0)
    events = machine.throw(0, "none", 5.0)
    check("a fast hand with no direction does not throw", not any(e.kind == "window.throw" for e in events))


# ---------------------------------------------------------------------------
# Gaze / head pose
# ---------------------------------------------------------------------------

def pose_matrix(yaw_deg: float, pitch_deg: float = 0.0) -> list[list[float]]:
    """A 4x4 whose third column is a face forward axis at (yaw, pitch)."""
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    fx = math.sin(yaw) * math.cos(pitch)
    fy = math.sin(pitch)
    fz = math.cos(yaw) * math.cos(pitch)
    return [
        [1.0, 0.0, fx, 0.0],
        [0.0, 1.0, fy, 0.0],
        [0.0, 0.0, fz, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def test_head_pose_reads_yaw() -> None:
    pose = head_pose(pose_matrix(32.0))
    check("head pose reads yaw", pose is not None and abs(pose.yaw - 32.0) < 0.5, str(pose))


def test_head_pose_reads_pitch() -> None:
    pose = head_pose(pose_matrix(0.0, 12.0))
    check("head pose reads pitch", pose is not None and abs(pose.pitch - 12.0) < 0.5, str(pose))


def test_head_pose_accepts_a_flat_16() -> None:
    flat = [value for row in pose_matrix(-28.0) for value in row]
    pose = head_pose(flat)
    check("head pose accepts a flat matrix", pose is not None and abs(pose.yaw + 28.0) < 0.5, str(pose))


def test_head_pose_rejects_garbage() -> None:
    okay = (
        head_pose(None) is None
        and head_pose([]) is None
        and head_pose("nope") is None
        and head_pose([[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]) is None
    )
    check("head pose rejects missing or degenerate matrices", okay)


def test_head_pose_rejects_a_face_pointing_away() -> None:
    check("a face turned past 120° is ignored", head_pose(pose_matrix(170.0)) is None)


def test_gaze_calibration_needs_separation() -> None:
    check("anchors 4° apart are unusable", not GazeCalibration(10.0, 14.0).is_usable())
    check("anchors 40° apart are usable", GazeCalibration(-20.0, 20.0).is_usable())


def test_gaze_calibration_round_trips() -> None:
    original = GazeCalibration(-24.0, 31.0)
    rebuilt = GazeCalibration.from_dict(original.as_dict())
    check(
        "gaze calibration round trips",
        rebuilt == original and rebuilt.is_usable(),
        f"{rebuilt}",
    )


def test_gaze_calibration_rejects_bad_files() -> None:
    bad_inputs = [
        None,
        {},
        {"yaw_laptop": "nope", "yaw_tablet": 20},
        {"yaw_laptop": 10, "yaw_tablet": 13},
        {"yaw_laptop": float("nan"), "yaw_tablet": 20},
        {"yaw_laptop": -200, "yaw_tablet": 20},
    ]
    rejected = 0
    for value in bad_inputs:
        try:
            GazeCalibration.from_dict(value)
        except ValueError:
            rejected += 1
    check("a corrupt gaze calibration is rejected", rejected == len(bad_inputs), f"{rejected}/{len(bad_inputs)}")


def test_uncalibrated_gaze_uses_the_default_split() -> None:
    """Out of the box: facing the camera is the laptop, a big turn is the iPad."""
    router = GazeRouter()
    router.observe(0, 0.0)
    router.observe(500, 0.0)
    check("uncalibrated gaze starts on the laptop", router.target == LAPTOP, str(router.target))
    check("an uncalibrated laptop look routes locally", router.release_target() == LAPTOP)

    # Turn far enough that the smoothed yaw clears the tablet threshold.
    for t in range(600, 1400, 33):
        router.observe(t, 50.0)
    check("uncalibrated gaze follows a turn to the iPad", router.target == TABLET, str(router.target))
    check("an uncalibrated tablet look routes to the iPad", router.release_target() == TABLET)

    # Returning to the camera must go back to the laptop.
    for t in range(1400, 2400, 33):
        router.observe(t, 0.0)
    check("uncalibrated gaze returns to the laptop", router.target == LAPTOP, str(router.target))


def test_gaze_dwell_before_committing() -> None:
    router = GazeRouter(GazeCalibration(-30.0, 30.0))
    router.observe(0, 30.0)
    router.observe(100, 30.0)
    check("a brief look does not commit", router.target is None, str(router.target))
    check("nothing to route before the dwell", router.release_target() is None)
    router.observe(400, 30.0)
    check("the dwell commits the look", router.target == TABLET, str(router.target))
    check("release routes to the iPad after the dwell", router.release_target() == TABLET)


def test_gaze_dead_zone_holds_the_last_decision() -> None:
    router = GazeRouter(GazeCalibration(-30.0, 30.0))
    router.observe(0, -30.0)
    router.observe(400, -30.0)
    # Sweep the head to the middle of the gap and let the smoother settle there.
    t = 500
    for _ in range(40):
        router.observe(t, 0.0)
        t += 50
    check("the dead zone keeps the laptop decision", router.target == LAPTOP, str(router.target))
    check("release in the dead zone still goes to the laptop", router.release_target() == LAPTOP)


def test_gaze_forgets_after_a_long_absence() -> None:
    router = GazeRouter(GazeCalibration(-30.0, 30.0))
    router.observe(0, -30.0)
    router.observe(400, -30.0)
    router.observe(700, None)
    check("a short dropout keeps the decision", router.target == LAPTOP, str(router.target))
    router.observe(1400, None)
    check("a long dropout forgets the decision", router.target is None, str(router.target))
    check("a forgotten face routes nothing", router.release_target() is None)


def test_gaze_release_needs_a_usable_calibration() -> None:
    router = GazeRouter(GazeCalibration(10.0, 14.0))
    router.observe(0, 12.0)
    router.observe(1000, 12.0)
    check("a calibration too narrow never routes", router.release_target() is None)


def test_a_held_grab_survives_the_hand_sweeping_out_wide() -> None:
    """Bug: dragging a window stopped part-way across the screen.

    Reported: "Moving of windows with the right fist is not reliable as it works
    but it is not continuous." A drag sweeps the hand across the body, and the
    distance from the mouth grows as it goes. Past `max_front_distance` the fist
    stopped counting as "in front", the grab was released after its grace, and
    the window stopped following - so the user had to raise the fist again for
    each half of the screen.

    Held, the far edge of the pickup band is not information: the only release
    worth making is the hand opening or returning to the mouth.
    """
    # A face 0.12 wide is somebody sitting at a desk, not leaning in, and it is
    # what makes the arithmetic here real: at the fixture's default width the
    # frame corners are only about 3.8 face widths from the mouth, so a hand
    # cannot get far enough away to leave the band in the first place.
    face = make_face(width=0.12)
    # Well past the pickup band's far edge, but clearly not at the mouth.
    hand = make_fist(Point(0.95, 0.9))
    loose = detect_fist(hand, face, world_hand=None)
    held = detect_fist(hand, face, world_hand=None, held=True)
    check(
        "a wide hand does not start a grab",
        not loose.in_front,
        loose.reason,
    )
    check("but a grab already held keeps it", held.in_front, held.reason)

    # The real check: the window keeps moving across a whole drag.
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for t in range(0, 600, 33):
        events += feed(machine, t, in_front=True, distance=1.8, curl=0.9, pointer=(0.4, 0.5))
        if t >= 400:
            # Swept far out to the side: the band the pickup needed is gone, but
            # `held` keeps `in_front` true.
            events += feed(
                machine, t + 10, in_front=True, distance=4.6, curl=0.9, pointer=(0.6, 0.5)
            )
    check(
        "the window was grabbed",
        any(e.kind == "window.grab" for e in events),
        str([e.kind for e in events]),
    )
    check(
        "and no release fired while the hand swept wide",
        not [e for e in events if e.kind == "window.release"],
        str([e.kind for e in events]),
    )


def test_the_left_hand_is_recognised_away_from_the_mouth_band() -> None:
    """Bug: the desktop swipe never fired at all.

    Reported: "Changing between desktops when I am looking at the laptop (It
    currently does not work)." There was no `Desktop switch` line in the log, so
    the gesture itself never reached the desktop app.

    The left hand was classified with the *right* hand's grab detector, which
    only calls a hand "in front" between 1.15 and 3.5 face widths from the
    mouth. A left hand held out to the side - where a swipe begins - sits far
    outside that band, so `left_fist` was never true and the machine was never
    fed the gesture.
    """
    face = make_face(width=0.12)
    # A closed left hand, held out to the side and away from the mouth.
    closed = make_anatomical_hand(Point(0.06, 0.92), curled=True)
    reading = detect_fist(closed, face)
    check("the grab band rejects a hand held out wide", not reading.in_front, reading.reason)
    check("but the swipe recognises it", left_fist_closed(closed), "closed hand not recognised")

    # An open hand must still do nothing. `make_anatomical_hand` builds real
    # finger proportions, so "open" here really is open rather than a fixture
    # whose knuckles are missing.
    open_hand = make_anatomical_hand(Point(0.06, 0.92), curled=False)
    check("an open left hand is not a swipe", not left_fist_closed(open_hand))
    check("and a missing hand is not a swipe", not left_fist_closed(None))


def test_a_left_fist_held_out_wide_still_walks_desktops() -> None:
    """The whole path, with the hand where a swipe actually starts."""
    machine = MouthGestureMachine()
    machine.arm(0)
    events: list = []
    for t, x in [(0, 0.20), (40, 0.31), (80, 0.44)]:
        events += feed(machine, t, in_front=False, hand=False, face=False,
                       left_fist=True, left_pointer=(x, 0.55))
    switched = [e.detail["direction"] for e in events if e.kind == "desktop.switch"]
    check("a closed left hand out wide switches desktops", bool(switched), str(switched))


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()

    failed = 0
    for name, ok, detail in _results:
        if ok:
            print(f"  ok   {name}")
        else:
            failed += 1
            print(f"  FAIL {name}  {detail}")

    print(f"\n{len(_results) - failed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
