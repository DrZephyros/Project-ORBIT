"""Geometry for the ORBIT hand-near-mouth detector.

Pure functions only: no camera, no MediaPipe import. That keeps the detector
unit-testable without hardware, which matters because a gesture that misfires is
worse than one that does not exist.

Coordinate conventions
----------------------
MediaPipe returns normalised landmarks (x, y in [0, 1], z relative depth). The
camera frame is mirrored with `cv2.flip` *before* it is handed to MediaPipe (see
`tracker.py`), so every landmark this module sees — image and metric world alike
— already uses the user's own left/right: +x is the user's right, the same
direction the mirrored preview draws in. Nothing here may flip x again; doing so
is what made the pointer aim backwards.

Distances are normalised by face width (or hand width) so a threshold means the
same thing whether you sit close to the laptop or lean back.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Sequence

# MediaPipe landmark indices (canonical model layout).
HAND_WRIST = 0
HAND_THUMB_TIP = 4
HAND_INDEX_TIP = 8
HAND_MIDDLE_TIP = 12
HAND_RING_TIP = 16
HAND_PINKY_TIP = 20

# The index finger's middle joint. Used both by the curl measurement and, via
# `detect_pointer`, to keep a fist from being mistaken for a pinch.
HAND_INDEX_PIP = 6
HAND_INDEX_MCP = 5
HAND_MIDDLE_MCP = 9
HAND_PINKY_MCP = 17

# Each finger as (MCP, PIP, TIP). The tip-to-MCP span shrinks as the finger
# curls, while MCP-to-PIP is a fixed bone that gives the ratio its scale. Working
# inside one finger keeps the measurement independent of wrist proportions and of
# how far away the hand is: an extended index is roughly twice its proximal
# phalanx, a closed one is well under it.
FINGER_CHAINS = (
    (HAND_INDEX_MCP, HAND_INDEX_PIP, HAND_INDEX_TIP),
    (9, 10, 12),  # middle
    (13, 14, 16),  # ring
    (17, 18, 20),  # pinky
)

# Ratio of tip-to-MCP over MCP-to-PIP for a fully open finger, and for a closed
# one. These are anatomical, not tuned to a particular camera: real open fingers
# land near 1.8-2.2 and a fist lands near 0.5-0.8.
FINGER_OPEN_RATIO = 1.9
FINGER_CLOSED_RATIO = 0.65

# Finger curl at which a hand counts as closed. Shared by the grab detector and
# the pinch gate so "this is a fist" means the same thing in both places.
FIST_CURL_THRESHOLD = 0.55

# How closed two fingers must be before a third may be ignored. A fully balled
# fist often reports one finger (usually the pinky, hidden behind the palm) as
# partly open; a pinch never gets two *other* fingers this closed, which is what
# keeps a click from turning into a grab.
FIST_STRONG_CURL = 0.8

# FaceMesh indices.
FACE_NOSE_TIP = 1
FACE_UPPER_LIP = 13
FACE_LOWER_LIP = 14
FACE_LEFT_CHEEK = 234
FACE_RIGHT_CHEEK = 454

# Smallest cross-product length accepted when building the palm plane, in m².
# Twice the area of the wrist/index/pinky triangle; a real palm gives ~1.5e-3,
# so this only rejects frames where the landmarks collapsed onto a line.
PALM_PLANE_MIN_AREA = 1.0e-4

# Pointer mapping: where the palm is, scaled up around a calibrated centre.
#
# This is a *position* device, like a trackpad: move the hand and the cursor
# follows. It replaced an attempt to aim by the palm's surface normal, and the
# reason that failed is anatomy rather than maths.
#
# A palm held facing the camera cannot be yawed by the wrist. Pronation turns it
# about the camera axis, which does not change where it points at all; radial
# and ulnar deviation turn it about its own normal, which also does not. The only
# way to yaw a palm is to swing the whole forearm from the elbow or shoulder, and
# in practice the measured yaw drifts by well under a degree while the hand moves
# around normally. So a normal-based cursor can move up and down (wrist flexion
# is easy and does change pitch) but never sideways — which is exactly how it
# behaved in use: stuck left, unreachable right edge.
#
# POINTER_POSITION_GAIN_X / _Y: screen fractions of travel per frame-width of
#   hand travel. A hand sweep of about 0.14 of the frame then covers half the
#   screen, so the whole screen is reachable without leaving the camera's view.
#   The gain was raised from 2.5/2.7 after use: the sweep felt too slow.
#   Y is slightly higher because a hand travels less far vertically than it does
#   horizontally, and the screen is taller per unit of frame height.
#   POINTER_GAIN is the one knob to turn if this feels too twitchy or too slow.
POINTER_CENTER = 0.5
POINTER_POSITION_GAIN_X = 3.5
POINTER_POSITION_GAIN_Y = 3.8

# Master multiplier over both gains, so sensitivity can be trimmed in one place.
POINTER_GAIN = 1.0

# Exponential smoothing factor for the cursor, per frame at 30 fps. Landmark
# position is far steadier than a derived normal, so this can be light.
# Lower = more responsive, higher = steadier. Tuned down with the gain bump.
POINTER_SMOOTHING = 0.30

# A cursor jump larger than this between frames (in screen fraction) is treated
# as a landmark glitch rather than real movement. Raised so fast intentional
# sweeps are not discarded.
POINTER_MAX_JUMP = 0.55


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    z: float = 0.0


@dataclass(frozen=True)
class MouthContact:
    """Result of one frame's geometry check."""

    near: bool
    distance: float
    """Distance from the closest fingertip to the mouth centre, in face widths."""

    hand_visible: bool
    face_visible: bool
    reason: str


@dataclass(frozen=True)
class FistReading:
    """How closed a hand is, and where it is being held."""

    curled: bool
    """True when the fingers are closed into a fist (or a cup)."""

    curl: float
    """0 = fingers fully extended, 1 = tips drawn right back to the wrist."""

    at_mouth: bool
    """A closed hand held close to the mouth."""

    in_front: bool
    """A closed hand held up in front of the body, away from the mouth."""

    distance: float
    """Distance from the fist centre to the mouth, in face widths."""

    hand_visible: bool
    face_visible: bool
    reason: str


def _as_point(value: object) -> Point:
    """Accept a MediaPipe landmark, a dict or a tuple without importing MediaPipe."""
    if isinstance(value, Point):
        return value
    if isinstance(value, dict):
        return Point(float(value["x"]), float(value["y"]), float(value.get("z", 0.0)))
    x = getattr(value, "x", None)
    if x is not None:
        return Point(float(x), float(getattr(value, "y", 0.0)), float(getattr(value, "z", 0.0) or 0.0))
    seq = value  # type: ignore[assignment]
    if isinstance(seq, Sequence) and len(seq) >= 2:
        return Point(float(seq[0]), float(seq[1]), float(seq[2]) if len(seq) > 2 else 0.0)
    raise TypeError(f"cannot read a point from {type(value)!r}")


def face_width(face: Iterable[object]) -> float:
    """Distance between the two cheek landmarks, used as the scale reference."""
    points = [_as_point(p) for p in face]
    if len(points) <= max(FACE_LEFT_CHEEK, FACE_RIGHT_CHEEK):
        return 0.0
    left = points[FACE_LEFT_CHEEK]
    right = points[FACE_RIGHT_CHEEK]
    return ((left.x - right.x) ** 2 + (left.y - right.y) ** 2) ** 0.5


def mouth_centre(face: Sequence[object] | None) -> Point | None:
    if face is None:
        return None
    points = [_as_point(p) for p in face]
    if len(points) <= FACE_LOWER_LIP:
        return None
    upper = points[FACE_UPPER_LIP]
    lower = points[FACE_LOWER_LIP]
    return Point((upper.x + lower.x) / 2.0, (upper.y + lower.y) / 2.0, (upper.z + lower.z) / 2.0)


def fingertip_points(hand: Sequence[object] | None) -> list[Point]:
    """The three fingertips that a cupped hand presents to the mouth."""
    if hand is None:
        return []
    points = [_as_point(p) for p in hand]
    if len(points) <= HAND_MIDDLE_TIP:
        return []
    return [points[HAND_INDEX_TIP], points[HAND_MIDDLE_TIP], points[HAND_THUMB_TIP]]


def detect_mouth_contact(
    hand: Sequence[object] | None,
    face: Sequence[object] | None,
    max_distance: float = 0.55,
    min_face_width: float = 0.04,
) -> MouthContact:
    """Is a hand held near the mouth this frame?

    `max_distance` is expressed in face widths so it does not depend on how far
    the user sits from the camera. A face narrower than `min_face_width` (in
    normalised image units) is too small or too far away to judge reliably, and
    we report "not near" rather than guessing.
    """

    if face is None:
        return MouthContact(False, float("inf"), hand is not None, False, "no face")

    width = face_width(face)
    if width < min_face_width:
        return MouthContact(False, float("inf"), hand is not None, False, "face too small")

    centre = mouth_centre(face)
    if centre is None:
        return MouthContact(False, float("inf"), hand is not None, False, "face landmarks incomplete")

    if hand is None:
        return MouthContact(False, float("inf"), False, True, "no hand")

    tips = fingertip_points(hand)
    if not tips:
        return MouthContact(False, float("inf"), False, True, "hand landmarks incomplete")

    best = float("inf")
    for tip in tips:
        dx = tip.x - centre.x
        dy = tip.y - centre.y
        # z is noisy on a single webcam; weight it lightly rather than trusting it.
        dz = (tip.z - centre.z) * 0.35
        distance = ((dx * dx + dy * dy + dz * dz) ** 0.5) / width
        best = min(best, distance)

    return MouthContact(best <= max_distance, best, True, True, "near" if best <= max_distance else "far")


def finger_curls(hand: Sequence[object]) -> list[float]:
    """Per-finger curl, in `FINGER_CHAINS` order: index, middle, ring, pinky.

    Returns an empty list when the hand is too incomplete to measure. Each value
    is normalised to 0 (extended) .. 1 (closed).
    """
    points = [_as_point(p) for p in hand]
    if len(points) <= HAND_PINKY_TIP:
        return []

    curls: list[float] = []
    for mcp_index, pip_index, tip_index in FINGER_CHAINS:
        mcp = points[mcp_index]
        pip = points[pip_index]
        tip = points[tip_index]
        bone = ((pip.x - mcp.x) ** 2 + (pip.y - mcp.y) ** 2) ** 0.5
        span = ((tip.x - mcp.x) ** 2 + (tip.y - mcp.y) ** 2) ** 0.5
        if bone <= 1e-6:
            continue
        ratio = span / bone
        curls.append((FINGER_OPEN_RATIO - ratio) / (FINGER_OPEN_RATIO - FINGER_CLOSED_RATIO))

    return [max(0.0, min(1.0, curl)) for curl in curls]


def finger_curls_3d(world_hand: Sequence[object] | None) -> list[float]:
    """Per-finger curl from MediaPipe's metric world landmarks.

    The 2D version measures a projection. When a hand is edge-on or a closed
    fist hides its fingertips behind the palm, that projection can make a
    fully balled finger look partly extended, so the fist never crossed the
    gate. World landmarks are real 3D in metres, independent of camera angle,
    and use the same anatomical ratio: tip-to-MCP over MCP-to-PIP.
    """
    if world_hand is None:
        return []
    points = [_as_point(p) for p in world_hand]
    if len(points) <= HAND_PINKY_TIP:
        return []

    curls: list[float] = []
    for mcp_index, pip_index, tip_index in FINGER_CHAINS:
        mcp = points[mcp_index]
        pip = points[pip_index]
        tip = points[tip_index]
        bone = ((pip.x - mcp.x) ** 2 + (pip.y - mcp.y) ** 2 + (pip.z - mcp.z) ** 2) ** 0.5
        span = ((tip.x - mcp.x) ** 2 + (tip.y - mcp.y) ** 2 + (tip.z - mcp.z) ** 2) ** 0.5
        if bone <= 1e-9:
            continue
        ratio = span / bone
        curls.append((FINGER_OPEN_RATIO - ratio) / (FINGER_OPEN_RATIO - FINGER_CLOSED_RATIO))

    return [max(0.0, min(1.0, curl)) for curl in curls]


def _closure_curls(
    hand: Sequence[object], world_hand: Sequence[object] | None = None
) -> list[float]:
    """The curl values that decide fist/scroll poses.

    Prefer the 3D metric landmarks whenever all four fingers could be measured:
    they are immune to the foreshortening that hides a real fist in the 2D
    projection. Fall back to the image landmarks when world data is missing so
    a camera that does not provide it still works.
    """
    curls_3d = finger_curls_3d(world_hand)
    if len(curls_3d) == len(FINGER_CHAINS):
        return curls_3d
    return finger_curls(hand)


def finger_curl(hand: Sequence[object], world_hand: Sequence[object] | None = None) -> float:
    """How closed the fingers are, from 0 (open) to 1 (fist).

    For each finger, compare the tip-to-MCP span with the MCP-to-PIP bone. Both
    lie inside the same finger, so how far away the hand is cancels out, and an
    edge-on hand does not break the measurement the way a wrist-distance ratio
    did. An extended finger is roughly 1.9 proximal phalanges long; a closed one
    folds the tip back to under 0.65.

    The previous version compared the fingertip with the wrist and used a
    1.9..1.1 band. That band is only right for an MCP, not the PIP it was fed,
    so a normal open hand computed around 0.75 and was classified as a fist. That
    is why every hand in front grabbed the window.

    `world_hand`, when supplied, gives the rotation-invariant 3D measurement.
    """
    curls = _closure_curls(hand, world_hand)
    if not curls:
        return 0.0
    # Average across the four fingers so one badly tracked fingertip cannot
    # decide the pose for the whole hand.
    return sum(curls) / len(curls)


def fist_pose(
    hand: Sequence[object],
    curl_threshold: float = FIST_CURL_THRESHOLD,
    world_hand: Sequence[object] | None = None,
) -> bool:
    """Whether the hand is closed into a grabbing fist.

    Deliberately ignores the index finger. A pinch *must* curl the index to
    bring its tip to the thumb, and many people also curl the middle finger, so
    averaging all four made a natural pinch cross the fist gate. The pinch then
    took the grab path and the click never fired. A real fist curls all three of
    middle, ring and pinky, so requiring those keeps the grab safe without
    vetoing a pinch.

    An incomplete hand falls back to the average, because there is not enough
    evidence to clear the fingers individually.
    """
    curls = _closure_curls(hand, world_hand)
    if not curls:
        return False
    if len(curls) < len(FINGER_CHAINS):
        return (sum(curls) / len(curls)) >= curl_threshold
    # curls[0] is the index; the other three decide.
    #
    # All three closed is a fist. A real balled hand is often reported with one
    # finger partly open — most often the pinky, which hides behind the palm —
    # so a single weak finger is tolerated *only* when the other two are
    # unambiguously closed. A pinch cannot reach that: it closes the middle but
    # leaves the ring and pinky open, so its second-strongest finger stays well
    # below `FIST_STRONG_CURL` and the click path keeps the hand.
    outer = sorted(curls[1:], reverse=True)
    if all(curl >= curl_threshold for curl in outer):
        return True
    return outer[1] >= FIST_STRONG_CURL


def fist_centre(hand: Sequence[object]) -> Point | None:
    """Approximate middle of the closed hand, between the two knuckles."""
    points = [_as_point(p) for p in hand]
    if len(points) <= HAND_PINKY_MCP:
        return None
    a = points[HAND_INDEX_MCP]
    b = points[HAND_PINKY_MCP]
    return Point((a.x + b.x) / 2.0, (a.y + b.y) / 2.0, (a.z + b.z) / 2.0)


def detect_fist(
    hand: Sequence[object] | None,
    face: Sequence[object] | None,
    curl_threshold: float = FIST_CURL_THRESHOLD,
    mouth_max_distance: float = 0.75,
    front_min_distance: float = 1.15,
    max_front_distance: float = 3.5,
    min_face_width: float = 0.04,
    pinching: bool = False,
    scrolling: bool = False,
    world_hand: Sequence[object] | None = None,
) -> FistReading:
    """Classify a closed hand as "cupped at the mouth" or "fist held in front".

    A cup and a fist are the same shape to this detector; what separates them is
    where the hand is relative to the mouth. The two distance bands deliberately
    do not touch, leaving a neutral gap the user must move through, so a hand
    drifting mid-way cannot flicker between the two actions.

    `pinching` and `scrolling` short-circuit the whole thing: both gestures curl
    fingers, so without this a pinching or scrolling hand was reported as a fist
    and the grab fired instead of the click or the scroll. A hand doing either is
    controlling the pointer, never grabbing.
    """

    if pinching or scrolling:
        # Still report the hand and face as visible so the machine keeps tracking,
        # but neither grab nor dictation can trigger while the fingers are busy.
        return FistReading(
            False,
            0.0,
            False,
            False,
            float("inf"),
            hand is not None,
            face is not None,
            "scrolling" if scrolling else "pinching",
        )

    if hand is None:
        return FistReading(False, 0.0, False, False, float("inf"), False, face is not None, "no hand")
    if face is None:
        return FistReading(False, 0.0, False, False, float("inf"), True, False, "no face")

    width = face_width(face)
    if width < min_face_width:
        return FistReading(False, 0.0, False, False, float("inf"), True, False, "face too small")

    centre = mouth_centre(face)
    if centre is None:
        return FistReading(False, 0.0, False, False, float("inf"), True, True, "face landmarks incomplete")

    fist = fist_centre(hand)
    if fist is None:
        return FistReading(False, 0.0, False, False, float("inf"), False, True, "hand landmarks incomplete")

    curl = finger_curl(hand, world_hand)
    dx = fist.x - centre.x
    dy = fist.y - centre.y
    dz = (fist.z - centre.z) * 0.35
    distance = ((dx * dx + dy * dy + dz * dz) ** 0.5) / width

    # Use the same three-finger rule as the pinch gate. Averaging the index in
    # made a loose cup (or a pinch with a partly extended index) fall short of
    # the threshold even though the hand was clearly closed. "Fist" must mean
    # one thing everywhere or a shape can be a grab in one path and a click in
    # the other.
    curled = fist_pose(hand, curl_threshold, world_hand=world_hand)
    at_mouth = curled and distance <= mouth_max_distance
    in_front = curled and front_min_distance <= distance <= max_front_distance

    if not curled:
        reason = "hand open"
    elif at_mouth:
        reason = "cupped at mouth"
    elif in_front:
        reason = "fist in front"
    elif distance < front_min_distance:
        reason = "between mouth and front"
    else:
        reason = "fist too far"

    return FistReading(curled, curl, at_mouth, in_front, distance, True, True, reason)


def landmark_payload(points: Sequence[object] | None) -> list[list[float]]:
    """Compact [x, y] pairs for the UI preview."""
    if not points:
        return []
    return [[round(_as_point(p).x, 4), round(_as_point(p).y, 4)] for p in points]


# ---------------------------------------------------------------------------
# Pointer: where the hand is, and whether it is pinching
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PointerReading:
    """Hand position as a cursor, plus pinch state."""

    x: float
    y: float
    """Cursor position in [0, 1], origin top-left, already mirrored for the user."""

    pinch: bool
    """True while the thumb and index finger are close enough to count as a pinch."""

    pinch_distance: float
    """Thumb-tip to index-tip distance, in hand-widths (size independent)."""

    hand_visible: bool
    confidence: float
    reason: str

    scrolling: bool = False
    """True while thumb + index + middle are pinched: the wheel gesture."""


def hand_width(hand: Sequence[object]) -> float:
    """Span between the index and pinky knuckles: a stable size reference."""
    points = [_as_point(p) for p in hand]
    if len(points) <= HAND_PINKY_MCP:
        return 0.0
    a = points[HAND_INDEX_MCP]
    b = points[HAND_PINKY_MCP]
    return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5


def _tip_distance(hand: Sequence[object], a_index: int, b_index: int) -> float:
    """Distance between two landmarks, in hand-widths (size independent)."""
    points = [_as_point(p) for p in hand]
    if len(points) <= max(a_index, b_index):
        return float("inf")
    width = hand_width(hand)
    if width <= 1e-6:
        return float("inf")
    a = points[a_index]
    b = points[b_index]
    return (((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5) / width


def pinch_distance(hand: Sequence[object]) -> float:
    """Thumb-tip to index-tip distance, normalised by hand width.

    Normalising means the same pinch gesture works close to the camera or far
    from it, and the threshold does not need recalibrating per user distance.
    """
    return _tip_distance(hand, HAND_THUMB_TIP, HAND_INDEX_TIP)


def middle_pinch_distance(hand: Sequence[object]) -> float:
    """Thumb-tip to middle-tip distance, in hand-widths.

    The three-finger scroll is thumb + index + middle, so whether the middle
    finger has joined the pinch is what separates scrolling from a two-finger
    click.
    """
    return _tip_distance(hand, HAND_THUMB_TIP, HAND_MIDDLE_TIP)


def three_finger_pinch(
    hand: Sequence[object] | None,
    pinch_on: float = 0.50,
    world_hand: Sequence[object] | None = None,
    open_curl: float = 0.75,
    middle_margin: float = 0.10,
    max_index_curl: float = 0.50,
) -> bool:
    """Thumb + index + middle pinched, with ring and pinky left open.

    This is the scroll gesture. Requiring the ring and pinky to stay open is
    what keeps it distinct from a fist: in a fist those two are curled too, and
    the thumb naturally rests beside the curled index, so distance alone would
    call a closed hand a pinch.

    The middle tip must be *as close to the thumb as the index tip is*, not
    merely within a loose absolute distance. A normal two-finger click brings
    the index to the thumb while the extended middle stays a little further
    away; with an absolute gate of `pinch_on + middle_margin` that two-finger
    click was read as a scroll, and live data showed the resulting `scrolling`
    state (and its cursor freeze) sticking for seconds. Comparing the two
    distances is scale-free and matches the gesture: in a real three-finger
    pinch both tips meet the thumb, so the distances differ by a few
    hundredths of a hand width.

    The outer fingers stay open (`open_curl`), looser than the fist gate because
    people naturally keep them partly bent. A balled fist still exceeds it on
    both fingers, so it cannot become a scroll.

    The index itself must stay fairly straight (`max_index_curl`). A scroll
    *reaches*: the tip travels out to the thumb while the finger stays extended.
    A fist folds the same finger in, and live data from this user showed the two
    poses are otherwise identical — a held fist reported index curls of 0.57-0.74
    with ispan 0.45-0.58, while their scroll pose reported 0.00-0.12 with ispan
    near 1.0. Without this gate the fist was a wheel on every frame, so the grab
    branch below never ran and the window could not be picked up at all.
    """
    if hand is None:
        return False
    index = pinch_distance(hand)
    middle = middle_pinch_distance(hand)
    if index > pinch_on or middle > pinch_on:
        return False
    if middle > index + middle_margin:
        return False

    curls = _closure_curls(hand, world_hand)
    if len(curls) < len(FINGER_CHAINS):
        return False
    # A folded index means the hand is closed, not reaching.
    # A reaching index stays nearly straight; a fist folds it well past halfway.
    #
    # Measured on the fixtures: a real three-finger scroll sits at about 0.14 and
    # a closed fist at about 0.94. The old gate of 0.50 left a wide band in the
    # middle where a *relaxed* fist - the shape a hand actually holds while
    # waiting to grab - was still accepted as a scroll, which is the "detects
    # fist in front as a pinch or scroll sometimes" report. Lowering it to 0.40
    # keeps every real scroll (they do not fold the index at all) while cutting
    # the fist band roughly in half.
    if curls[0] >= 0.40:
        return False
    # curls[2] is the ring, curls[3] the pinky.
    #
    # A cupped fist and a scroll reach nearly the same ring/pinky curl, so the
    # `open_curl` band alone lets a fist through as a wheel — and a fist *in
    # motion* looks like a sweep, which is why cupping while moving scrolled the
    # page instead of grabbing. The remaining difference is how folded the index
    # is: a scroll reaches out with it, a cup folds it in. Requiring a clearly
    # straighter index when the outer fingers are only partly open keeps real
    # scrolls working while a moving cup stops being a wheel.
    outer = max(curls[2], curls[3])
    if outer >= open_curl:
        return False
    if outer >= open_curl * 0.75 and curls[0] >= max_index_curl * 0.8:
        # Partly-open ring/pinky plus a folded index is the cup, not a reach.
        return False
    # A folded index is decisive on its own, whatever the outer fingers are doing.
    #
    # Reported: "It detects fist in front as a pinch or scroll sometimes."
    #
    # The band above only rejected the cup when the ring or pinky was *partly*
    # open (outer >= 0.75 * open_curl). A relaxed fist often sits just under
    # that - the outer fingers still bent, the index folded to about 0.45 - and
    # slipped through both gates, so a held fist read as a wheel and a moving one
    # scrolled. The scroll gesture reaches out with the index; a fist cannot.
    # Making the index test unconditional closes the gap without touching a
    # genuine three-finger pinch, which never folds it.
    if curls[0] >= max_index_curl * 0.8:
        return False
    return True


def pose_metrics(
    hand: Sequence[object] | None,
    world_hand: Sequence[object] | None = None,
) -> dict[str, float]:
    """Scale-free lengths that tell a fist apart from a three-finger scroll.

    Curl alone cannot do it. In a real fist MediaPipe reports the ring and pinky
    at roughly 0.56-0.67, and a real scroll pose reports almost the same values,
    so every curl gate that accepts one accepts the other. That is why holding a
    fist scrolled the page instead of grabbing the window.

    These three numbers measure where the hand is *reaching* instead:

    * `thumbReach`   thumb tip to wrist
    * `indexSpan`    index tip to index knuckle
    * `middleSpan`   middle tip to middle knuckle

    A fist folds the fingers in and tucks the thumb across them, so all three
    shrink. A scroll extends the thumb out to meet the index and middle tips, so
    all three grow. Metric world landmarks are preferred; the image projection
    inflates an edge-on hand badly enough to invert the comparison.

    Everything is divided by the index-to-pinky knuckle span, so the numbers mean
    the same thing close to the camera and far away.
    """
    source = world_hand if world_hand else hand
    if not source:
        return {}
    points = [_as_point(p) for p in source]
    if len(points) <= HAND_PINKY_MCP:
        return {}
    three_d = bool(world_hand)

    def span(a: Point, b: Point) -> float:
        dz = (a.z - b.z) if three_d else 0.0
        return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + dz * dz) ** 0.5

    width = span(points[HAND_INDEX_MCP], points[HAND_PINKY_MCP])
    if width <= 1e-9:
        return {}
    return {
        "thumbReach": round(span(points[HAND_THUMB_TIP], points[HAND_WRIST]) / width, 3),
        "indexSpan": round(span(points[HAND_INDEX_TIP], points[HAND_INDEX_MCP]) / width, 3),
        "middleSpan": round(span(points[HAND_MIDDLE_TIP], points[HAND_MIDDLE_MCP]) / width, 3),
    }


def pointer_anchor(hand: Sequence[object]) -> Point | None:
    """The palm centre, in normalised image coordinates: the point the cursor
    follows.

    Deliberately *not* a fingertip. A pinch is thumb-to-index-tip contact, so the
    index tip physically travels as the user pinches — tracking it dragged the
    cursor every time they clicked. The palm centre is rigid during finger
    flexion: the index and pinky knuckles barely move when the fingers close, so
    the cursor stays still while the pinch opens and closes.

    The midpoint of the two outer knuckles is used rather than the wrist, because
    the wrist swings a lot on forearm rotation and would swing the cursor with it.
    The midpoint is also immune to the knuckle line's tilt, so rolling the hand
    does not drag the cursor sideways.

    The raw value is returned; the gain and the calibrated centre are applied by
    `pointer_position`, so this stays a pure measurement.
    """
    points = [_as_point(p) for p in hand]
    if len(points) <= max(HAND_INDEX_MCP, HAND_PINKY_MCP):
        return None
    index = points[HAND_INDEX_MCP]
    pinky = points[HAND_PINKY_MCP]
    return Point((index.x + pinky.x) / 2.0, (index.y + pinky.y) / 2.0)


def palm_frame(world_hand: Sequence[object]) -> tuple[Point, Point, Point] | None:
    """Origin, an in-plane axis, and the outward normal of the palm.

    Built from the *metric 3D* world landmarks (`hand_world_landmarks`), not the
    normalised image ones: image depth is only relative, so it cannot say which
    way the palm faces.

    The plane is spanned by the wrist and the two outer knuckles (index and
    pinky MCP). Those three points are far apart — roughly 9 cm by 6 cm — and
    form a solid triangle across the palm plate, so the normal they produce is
    stable against landmark jitter.

    An earlier version used the three *knuckles* (index, middle, pinky MCP).
    That triangle is nearly degenerate: the three points sit almost on one
    straight line, so the cross product's direction was decided by a 2 mm
    difference in y — the same size as MediaPipe's own noise. The normal's tilt
    was therefore essentially random from frame to frame, which is why the
    cursor wandered and often pointed backwards no matter how the hand was
    held. Including the wrist makes the triangle's area ~25x larger and the
    normal's direction is then set by the pose rather than by noise.

    The normal is forced to point *out of the palm*, i.e. toward the camera,
    which is the -z direction in the camera's frame. The cross product's sign
    depends on the winding of the points, which flips between left and right
    hands, so it is fixed explicitly rather than assumed.
    """
    pts = [_as_point(p) for p in world_hand]
    needed = max(HAND_WRIST, HAND_INDEX_MCP, HAND_MIDDLE_MCP, HAND_PINKY_MCP)
    if len(pts) <= needed:
        return None

    wrist = pts[HAND_WRIST]
    index = pts[HAND_INDEX_MCP]
    middle = pts[HAND_MIDDLE_MCP]
    pinky = pts[HAND_PINKY_MCP]
    origin = middle

    # Two edges of the palm plate, then their cross product: the surface normal.
    u = _sub(index, wrist)
    v = _sub(pinky, wrist)
    raw = _cross(u, v)

    # Reject a degenerate triangle. Its length is twice the palm plate's area;
    # for a real hand that is ~1.5e-3 m², so anything near zero means the
    # landmarks collapsed and the normal would be meaningless.
    if (raw.x * raw.x + raw.y * raw.y + raw.z * raw.z) ** 0.5 < PALM_PLANE_MIN_AREA:
        return None

    normal = _normalise(raw)
    if normal is None:
        return None

    # A palm facing the camera has its normal pointing at the camera, i.e. -z.
    if normal.z > 0:
        normal = _scale(normal, -1.0)

    return (origin, _normalise(u) or u, normal)


def palm_normal(world_hand: Sequence[object]) -> Point | None:
    """The outward palm normal, or None when the landmarks are unusable."""
    frame = palm_frame(world_hand)
    return None if frame is None else frame[2]


@dataclass(frozen=True)
class PointerCalibration:
    """Where the hand sits when the user wants the cursor in the middle.

    This is the anchor for a *position* mapping: the palm centre measured at the
    moment the user pressed Calibrate, in normalised image coordinates. Every
    later frame is measured as an offset from it, so a hand held in the user's
    natural working pose maps to dead centre instead of wherever their arm
    happens to rest.

    Without it the mapping would still work, but the centre of the screen would
    sit wherever the middle of the camera frame is — which is not where a person
    actually holds their hand.

    `hand` is the handedness label that was visible when the calibration was
    taken. It is used to pick the same hand out of the frame later, which is
    more reliable than assuming a label convention — the labels have been
    observed to disagree with the documentation on at least one build.
    """

    x: float
    y: float
    hand: str = ""

    def as_dict(self) -> dict[str, object]:
        return {"x": round(self.x, 6), "y": round(self.y, 6), "hand": self.hand}

    @staticmethod
    def from_dict(raw: object) -> "PointerCalibration | None":
        """Rebuild from stored JSON, tolerating a corrupt or partial file.

        A file written by the old aim-based calibration has `aim_x`/`aim_y`
        instead of `x`/`y`. It is rejected rather than misinterpreted: those
        numbers are tangents of palm angles, and treating them as image
        coordinates would put the cursor in a corner.
        """
        if not isinstance(raw, dict):
            return None
        try:
            x = float(raw["x"])
            y = float(raw["y"])
        except (KeyError, TypeError, ValueError):
            return None
        # A stale aim-based file could still be numerically parseable if it
        # happened to carry both keys; guard the range as well.
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            return None
        return PointerCalibration(x, y, str(raw.get("hand", "") or ""))


def calibration_from(hand: Sequence[object], label: str = "") -> PointerCalibration | None:
    """Take a calibration from where the palm is right now.

    `label` is the handedness MediaPipe reported for this hand, stored so the
    same hand can be picked out of the frame later.
    """
    anchor = pointer_anchor(hand)
    if anchor is None:
        return None
    return PointerCalibration(anchor.x, anchor.y, label)


def pointer_position(
    hand: Sequence[object],
    world_hand: Sequence[object] | None = None,
    center: float = POINTER_CENTER,
    calibration: PointerCalibration | None = None,
) -> tuple[float, float] | None:
    """Where the hand is, as a cursor position in [0, 1].

    The palm centre's position in the frame is scaled up around the calibrated
    neutral point, so a comfortable sweep of the hand covers the whole screen.
    This is the mapping a trackpad uses, and it is what the hand can actually do:
    position is easy and precise, whereas a palm facing the camera cannot be
    yawed by the wrist at all (see the module constants).

    `world_hand` is accepted but not used for the cursor — metric world
    landmarks are hand-centred, so they carry no absolute position. The
    parameter is kept so callers do not have to branch.

    Sign convention: `tracker.py` mirrors the frame with `cv2.flip` *before*
    MediaPipe sees it, so landmark x is already in the user's own left/right
    frame, the same one the mirrored preview draws in. Moving the hand to the
    user's right raises x, which must raise the cursor's x. Nothing here may
    flip it again.

    Returning None means the landmarks were unusable this frame; the caller
    holds the last good position rather than emitting a wild jump.
    """
    anchor = pointer_anchor(hand)
    if anchor is None:
        return None

    origin_x = calibration.x if calibration is not None else center
    origin_y = calibration.y if calibration is not None else center

    # +y is down in image space and on screen, so both axes map straight through.
    x = center + (anchor.x - origin_x) * POINTER_POSITION_GAIN_X * POINTER_GAIN
    y = center + (anchor.y - origin_y) * POINTER_POSITION_GAIN_Y * POINTER_GAIN
    return (max(0.0, min(1.0, x)), max(0.0, min(1.0, y)))





def _sub(a: Point, b: Point) -> Point:
    return Point(a.x - b.x, a.y - b.y, a.z - b.z)


def _cross(a: Point, b: Point) -> Point:
    return Point(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )


def _dot(a: Point, b: Point) -> float:
    return a.x * b.x + a.y * b.y + a.z * b.z


def _scale(a: Point, k: float) -> Point:
    return Point(a.x * k, a.y * k, a.z * k)


def _normalise(a: Point) -> Point | None:
    length = (a.x * a.x + a.y * a.y + a.z * a.z) ** 0.5
    if length <= 1e-9:
        return None
    return Point(a.x / length, a.y / length, a.z / length)


def swap_handedness(labels: Sequence[str]) -> list[str]:
    """Exchange MediaPipe's Left/Right labels.

    MediaPipe's Hand Landmarker documents that handedness describes the
    *subject's* hands and that "passing a horizontally mirrored image will invert
    these outputs". The tracker flips the camera frame with ``cv2.flip`` before
    inference so the preview and the pointer's x-axis match the user, which means
    every label arrives inverted: the user's right hand is returned as "Left".

    Not swapping it bound the pointer to the wrong limb — the cursor followed the
    left hand and the right hand was treated as absent, so its fist could never
    grab. The older MediaPipe *Solutions* API had the opposite convention
    ("assumes mirrored input"), and that is what the code was written against.

    Unknown or empty labels are passed through untouched so a marginal frame
    cannot accidentally become a valid hand.
    """
    swapped: list[str] = []
    for label in labels:
        key = str(label).strip().lower()
        if key == "left":
            swapped.append("Right")
        elif key == "right":
            swapped.append("Left")
        else:
            swapped.append(str(label))
    return swapped


def pick_hand_index(labels: Sequence[str], prefer: str = "Right") -> int | None:
    """Which detected hand should drive the cursor.

    Only the requested hand may drive the pointer. The pointer is bound to the
    user's **right** palm: a second hand (the left, resting or gesturing) must
    not steal the cursor, and a lone left hand must not start moving it either.
    Reporting nothing in that case is deliberate — the service then treats the
    frame as "no hand", so neither the cursor nor a gesture is driven by the
    wrong limb. Previously this fell back to index 0, which meant any left hand
    in view could move the pointer on its own.

    `prefer` is the handedness label MediaPipe reported, compared
    case-insensitively.
    """
    if not labels:
        return None
    want = (prefer or "Right").strip().lower()
    for index, label in enumerate(labels):
        if str(label).strip().lower() == want:
            return index
    return None


class PointerSmoother:
    """Exponential smoothing for the cursor, with a hold on bad frames.

    Landmark position jitters, and a frame can arrive with incomplete landmarks.
    Rather than freezing the cursor or letting it snap, a rejected frame keeps
    the last good position and the next good frame eases towards the new one.

    Two things make this stable in practice:

    * The smoothing is *time based*, not per-frame. A fixed per-frame factor
      behaves differently at 12 fps and 30 fps, which is why the cursor felt
      twitchy on a fast machine and laggy on a slow one.
    * A single frame that jumps further than any real hand could move is treated
      as a landmark glitch and ignored. Without this, one bad frame teleported
      the cursor across the screen and the next frame dragged it back.
    """

    def __init__(
        self,
        alpha: float = POINTER_SMOOTHING,
        max_jump: float = POINTER_MAX_JUMP,
        max_gap_ms: int = 250,
    ) -> None:
        self.alpha = max(0.05, min(1.0, alpha))
        self.max_jump = max_jump
        self.max_gap_ms = max_gap_ms
        self.value: tuple[float, float] | None = None
        self._last_ms: int | None = None

    def reset(self) -> None:
        self.value = None
        self._last_ms = None

    def update(
        self,
        target: tuple[float, float] | None,
        now_ms: int | None = None,
    ) -> tuple[float, float] | None:
        if target is None:
            # No usable reading this frame: hold, do not jump.
            return self.value

        if self.value is None:
            self.value = target
            self._last_ms = now_ms
            return self.value

        ax, ay = self.value
        bx, by = target

        # A long gap means tracking was lost and the hand has genuinely moved.
        # Snap to the new position: the jump guard below is for glitches between
        # consecutive frames, not for a hand that reappeared somewhere else.
        gap = None if now_ms is None or self._last_ms is None else now_ms - self._last_ms
        if gap is not None and gap > self.max_gap_ms:
            self.value = target
            self._last_ms = now_ms
            return self.value

        # Reject a physically impossible jump. A hand cannot cross a third of the
        # screen between two frames; a landmark glitch can.
        if ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 > self.max_jump:
            return self.value

        # Time-based easing: the same feel regardless of frame rate.
        if gap is None:
            factor = self.alpha
        else:
            # alpha is defined for a 30 fps frame; scale it by elapsed time.
            factor = 1.0 - (1.0 - self.alpha) ** (max(gap, 1) / (1000.0 / 30.0))

        self.value = (ax + (bx - ax) * factor, ay + (by - ay) * factor)
        self._last_ms = now_ms
        return self.value


def detect_pointer(
    hand: Sequence[object] | None,
    pinch_on: float = 0.50,
    pinch_off: float = 0.68,
    min_confidence: float = 0.5,
    confidence: float = 1.0,
    was_pinching: bool = False,
    was_scrolling: bool = False,
    world_hand: Sequence[object] | None = None,
    calibration: PointerCalibration | None = None,
    fist_curl_threshold: float = FIST_CURL_THRESHOLD,
) -> PointerReading:
    """Read the hand as a cursor, with a hysteresis pinch.

    Two thresholds are used instead of one (`pinch_on` < `pinch_off`) so the
    click does not chatter: the finger must come clearly together to press, and
    clearly apart to release. A single threshold would flicker on the boundary
    and emit a stream of clicks.

    A closed hand is *never* a pinch. In a fist the thumb naturally rests beside
    the curled index tip, so thumb-to-index distance alone reports a pinch — and
    that made the grab gesture fire a stray click. The same curl value the grab
    detector uses decides this, so "fist" means one thing across the service.

    Thumb + index + middle together is a scroll. It is checked before the pinch
    so the click path is suppressed on the same frame the third finger arrives;
    otherwise the hand would click and then start scrolling.

    `calibration` is the palm position the user captured as "the middle", if
    any; without it the middle of the camera frame is treated as the middle of
    the screen.
    """
    if hand is None:
        return PointerReading(0.0, 0.0, False, float("inf"), False, confidence, "no hand")

    if confidence < min_confidence:
        return PointerReading(0.0, 0.0, False, float("inf"), True, confidence, "low confidence")

    position = pointer_position(hand, world_hand=world_hand, calibration=calibration)
    if position is None:
        return PointerReading(
            0.0, 0.0, False, float("inf"), False, confidence, "hand landmarks incomplete"
        )

    reason = "point"

    distance = pinch_distance(hand)
    if distance == float("inf"):
        return PointerReading(position[0], position[1], False, distance, True, confidence, "hand landmarks incomplete")

    if three_finger_pinch(hand, pinch_on=pinch_on, world_hand=world_hand):
        return PointerReading(
            position[0], position[1], False, distance, True, confidence, "scroll", True
        )

    # A scroll that is already running stays a scroll through a pose flicker.
    #
    # `was_scrolling` was accepted by this function but never used, so the moment
    # the third finger drifted off the thumb the pose stopped matching and the
    # hand fell straight through to the pinch below — which pressed the button
    # mid-scroll. That is the "instead of scrolling it selects" report: the wheel
    # stuttered and a selection started underneath it.
    #
    # While a scroll is in progress the click must stay suppressed, so the hand
    # falls no further than this.
    #
    # This is deliberately *not* `scrolling=True`. Reporting the pose again here
    # made the caller refresh its "last seen scrolling" timestamp from its own
    # latched value, so the latch re-armed itself every frame and the wheel never
    # ended — the hand opened and the page kept scrolling forever. The caller owns
    # the timing; this only says "do not click".
    if was_scrolling:
        return PointerReading(
            position[0], position[1], False, distance, True, confidence, "scroll", False
        )

    # Suppress the pinch before the hysteresis, so a hand that closes into a fist
    # also releases any pinch that was already held instead of clicking on the way.
    # This must test the *non-index* fingers: pinching curls the index by
    # definition, and averaging it in made a natural pinch look like a fist.
    if fist_pose(hand, fist_curl_threshold, world_hand=world_hand):
        return PointerReading(position[0], position[1], False, distance, True, confidence, "fist")

    # Hysteresis: which threshold applies depends on the current state.
    if was_pinching:
        pinch = distance <= pinch_off
    else:
        pinch = distance <= pinch_on

    return PointerReading(
        position[0],
        position[1],
        pinch,
        distance,
        True,
        confidence,
        "pinch" if pinch else reason,
    )


# ---------------------------------------------------------------------------
# Throw: which way was the hand flicked?
# ---------------------------------------------------------------------------

class ThrowDirection(str, Enum):
    """Coarse flick directions. Coarse on purpose: a fine angle would misfire."""

    LEFT = "left"
    RIGHT = "right"
    UP = "up"
    DOWN = "down"
    NONE = "none"


@dataclass
class _Sample:
    at_ms: int
    x: float
    y: float
    pinching: bool


class ThrowTracker:
    """Detects a deliberate throw from the last moments of hand movement.

    A throw is judged only at the instant the hand opens (the release), using a
    short history of positions. Requiring a pinch beforehand is what separates a
    throw from a hand that merely happens to move quickly, which would otherwise
    fire constantly during normal gesturing.
    """

    def __init__(self, window_ms: int = 180, min_speed: float = 0.9) -> None:
        self.window_ms = window_ms
        # Screen-widths per second. Below this the movement is just repositioning.
        self.min_speed = min_speed
        self._samples: list[_Sample] = []

    def reset(self) -> None:
        self._samples.clear()

    def observe(self, now_ms: int, x: float, y: float, pinching: bool) -> None:
        """Record a frame. Call once per frame, before asking for a direction."""
        self._samples.append(_Sample(now_ms, x, y, pinching))
        # Keep only the recent window; older samples cannot describe a flick.
        cutoff = now_ms - max(self.window_ms * 3, 500)
        while self._samples and self._samples[0].at_ms < cutoff:
            self._samples.pop(0)

    def direction(self, now_ms: int, min_dominance: float = 1.6) -> tuple[ThrowDirection, float]:
        """Return the flick direction and speed, or (NONE, 0) if it was not a throw.

        The dominant axis must beat the other by `min_dominance` so a diagonal
        wobble does not claim a direction it did not really travel in.
        """
        recent = [s for s in self._samples if s.at_ms >= now_ms - self.window_ms]
        if len(recent) < 2:
            return ThrowDirection.NONE, 0.0

        first = recent[0]
        last = recent[-1]
        elapsed_ms = last.at_ms - first.at_ms
        if elapsed_ms <= 0:
            return ThrowDirection.NONE, 0.0

        dx = last.x - first.x
        dy = last.y - first.y
        seconds = elapsed_ms / 1000.0
        speed = ((dx * dx + dy * dy) ** 0.5) / seconds

        if speed < self.min_speed:
            return ThrowDirection.NONE, speed

        adx, ady = abs(dx), abs(dy)
        if adx >= ady * min_dominance:
            return (ThrowDirection.RIGHT if dx > 0 else ThrowDirection.LEFT), speed
        if ady >= adx * min_dominance:
            return (ThrowDirection.DOWN if dy > 0 else ThrowDirection.UP), speed
        return ThrowDirection.NONE, speed
