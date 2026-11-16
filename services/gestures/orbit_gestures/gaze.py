"""Head pose, and which screen the user is looking at.

Two screens, one head. The laptop sits in front of the user and the iPad off to
one side, so "where am I looking" reduces to "how far is the head turned". That
is a large, slow, reliable signal (25-40 degrees to reach the iPad), and it
needs no extra model: MediaPipe's FaceLandmarker already emits a facial
transformation matrix, which *is* the face's pose in camera space.

Eye position inside the socket would be finer, but iris landmarks are only a
few pixels wide at webcam distance and the decision here is binary, so the
steadier signal wins.

Nothing in this module assumes which side the iPad is on, or which way the pose
maths signs its yaw. The user looks at each screen once and records an anchor;
every later decision is "which anchor is the head nearer". That makes the
convention irrelevant, which matters because MediaPipe's axis conventions have
already been observed to disagree with its own documentation on this machine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

LAPTOP = "laptop"
TABLET = "tablet"

TARGETS = (LAPTOP, TABLET)

# Anchors closer together than this cannot be told apart reliably: at webcam
# distance a few degrees of yaw is a shrug. A calibration that produced them is
# rejected outright rather than left half-working.
MIN_SEPARATION_DEG = 6.0

# How long the head must stay on one side before the router believes it. Short
# enough that a deliberate look-and-release works, long enough that a glance
# mid-grab does not commit the window.
DEFAULT_DWELL_MS = 320

# The middle of the gap between the anchors, as a fraction of that gap. Inside
# this band the router keeps whatever it last decided instead of flapping.
DEAD_ZONE = 0.22

# How long a missing face is tolerated before the last target is forgotten.
# A single dropped frame must not cancel a decision.
LOST_GRACE_MS = 700

# Smoothing factor for the yaw reading. Head pose is noisier than it looks:
# the landmarker re-fits the whole face every frame.
YAW_SMOOTHING = 0.35

# A pose outside this is a tracking artefact, not a person turning round.
MAX_YAW_DEG = 120.0

# Default routing without calibration. The camera sits in the laptop, so facing
# the laptop is yaw ~0. The iPad is off to one side, whichever side that is, so a
# large turn in *either* direction means "away from the laptop". This makes the
# pointer and release routing work out of the box; recording the two anchors
# refines it when the laptop is off-axis or the iPad sits close to straight ahead.
DEFAULT_TABLET_YAW_DEG = 22.0
DEFAULT_LAPTOP_YAW_DEG = 12.0


@dataclass(frozen=True)
class HeadPose:
    """Head orientation in degrees, relative to facing the camera.

    Only the sign convention of `yaw` is unspecified — it is consistent within a
    run, which is all the router needs.
    """

    yaw: float
    pitch: float


def head_pose(matrix: Sequence[Any] | None) -> HeadPose | None:
    """Read yaw and pitch from a facial transformation matrix.

    The matrix maps MediaPipe's canonical face model into camera space, so its
    third column is the face's forward axis (the model's +Z) expressed in camera
    coordinates. When the user faces the camera that vector is ~(0, 0, 1), and
    turning the head swings its x component. Measuring the angle of that vector
    avoids composing Euler angles by hand, which is where sign conventions and
    gimbal surprises live.
    """
    rows = _as_rows(matrix)
    if rows is None:
        return None

    fx, fy, fz = rows[0][2], rows[1][2], rows[2][2]
    norm = math.sqrt(fx * fx + fy * fy + fz * fz)
    if norm < 1e-6:
        return None
    fx, fy, fz = fx / norm, fy / norm, fz / norm

    yaw = math.degrees(math.atan2(fx, fz))
    if abs(yaw) > MAX_YAW_DEG:
        # The face is pointing away from the camera: nothing useful to read.
        return None
    pitch = math.degrees(math.atan2(fy, math.hypot(fx, fz)))
    return HeadPose(yaw=yaw, pitch=pitch)


def _as_rows(matrix: Sequence[Any] | None) -> list[list[float]] | None:
    """Accept a 4x4, a flat 16, or a numpy array. Return rows or None."""
    if matrix is None:
        return None
    if hasattr(matrix, "tolist"):
        matrix = matrix.tolist()  # numpy, from MediaPipe
    try:
        values = list(matrix)
    except TypeError:
        return None

    # A flat 16 has to be reshaped *before* trying to iterate its entries as
    # rows: `list(float)` raises, so the old order rejected the form MediaPipe
    # actually hands us for a flattened matrix.
    if len(values) == 16 and not isinstance(values[0], (list, tuple)):
        try:
            flat = [float(value) for value in values]
        except (TypeError, ValueError):
            return None
        rows = [flat[i * 4 : (i + 1) * 4] for i in range(4)]
    else:
        try:
            rows = [list(map(float, row)) for row in values]  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None

    if len(rows) < 3 or any(len(row) < 3 for row in rows[:3]):
        return None
    return rows


@dataclass(frozen=True)
class GazeCalibration:
    """The yaw reading for each screen, captured while the user looked at it."""

    yaw_laptop: float
    yaw_tablet: float

    @property
    def separation(self) -> float:
        return abs(self.yaw_tablet - self.yaw_laptop)

    def is_usable(self) -> bool:
        return (
            math.isfinite(self.yaw_laptop)
            and math.isfinite(self.yaw_tablet)
            and self.separation >= MIN_SEPARATION_DEG
        )

    def position(self, yaw: float) -> float:
        """Where `yaw` falls between the two anchors: 0 laptop, 1 tablet."""
        span = self.yaw_tablet - self.yaw_laptop
        if abs(span) < 1e-6:
            return 0.0
        return (yaw - self.yaw_laptop) / span

    def as_dict(self) -> dict[str, Any]:
        return {"yaw_laptop": self.yaw_laptop, "yaw_tablet": self.yaw_tablet}

    @classmethod
    def from_dict(cls, data: Any) -> "GazeCalibration":
        """Rebuild from disk, rejecting anything that could not have come from
        a real calibration — a corrupt file must not silently decide which
        screen the user is looking at."""
        if not isinstance(data, dict):
            raise ValueError("gaze calibration must be an object")
        try:
            laptop = float(data["yaw_laptop"])
            tablet = float(data["yaw_tablet"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("gaze calibration is missing anchors") from exc
        if not (math.isfinite(laptop) and math.isfinite(tablet)):
            raise ValueError("gaze calibration is not finite")
        if abs(laptop) > MAX_YAW_DEG or abs(tablet) > MAX_YAW_DEG:
            raise ValueError("gaze calibration is out of range")
        cal = cls(laptop, tablet)
        if not cal.is_usable():
            raise ValueError("gaze calibration anchors are too close together")
        return cal


class GazeRouter:
    """Turns a stream of yaw readings into "laptop" or "tablet".

    Three defences against the wrong answer, in order: smoothing, a dead zone
    between the anchors, and a dwell time before a change is believed. A single
    noisy frame can therefore never move a window to the other screen.
    """

    def __init__(
        self,
        calibration: GazeCalibration | None = None,
        dwell_ms: int = DEFAULT_DWELL_MS,
    ) -> None:
        self.calibration = calibration
        self.dwell_ms = dwell_ms
        self.yaw: float | None = None
        self.target: str | None = None
        self.samples = 0
        self._candidate: str | None = None
        self._candidate_since = 0
        self._last_seen: int | None = None

    def observe(self, now_ms: int, yaw: float | None) -> None:
        if yaw is None:
            # No face: hold the last decision through short dropouts, then let
            # it go. Holding forever would let a stale look decide a release
            # minutes later.
            if self._last_seen is not None and now_ms - self._last_seen > LOST_GRACE_MS:
                self.yaw = None
                self.target = None
                self._candidate = None
                self._last_seen = None
            return

        self._last_seen = now_ms
        self.samples += 1
        self.yaw = yaw if self.yaw is None else self.yaw + (yaw - self.yaw) * YAW_SMOOTHING

        calibration = self.calibration
        if calibration is not None and calibration.is_usable():
            position = calibration.position(self.yaw)
            if position <= 0.5 - DEAD_ZONE / 2:
                candidate = LAPTOP
            elif position >= 0.5 + DEAD_ZONE / 2:
                candidate = TABLET
            else:
                # Between the two screens: commit to neither. The last decision
                # stands, which is what stops a sweep across the middle from
                # flickering the target.
                self._candidate = None
                return
        elif calibration is None:
            # No anchors yet: use the camera-relative default. Facing the laptop
            # is yaw 0 because the webcam lives in the laptop; a big turn either
            # way is the iPad. The gap between the thresholds is the dead zone.
            magnitude = abs(self.yaw)
            if magnitude >= DEFAULT_TABLET_YAW_DEG:
                candidate = TABLET
            elif magnitude <= DEFAULT_LAPTOP_YAW_DEG:
                candidate = LAPTOP
            else:
                self._candidate = None
                return
        else:
            # A half-built or corrupt calibration cannot separate anything.
            self.target = None
            return

        if candidate != self._candidate:
            self._candidate = candidate
            self._candidate_since = now_ms
            return

        if self.target != candidate and now_ms - self._candidate_since >= self.dwell_ms:
            self.target = candidate

    def release_target(self) -> str | None:
        """Where a window released now should go, or None when the head is unknown.

        A decided target is enough. Without calibration the router uses the
        camera-relative default (facing the laptop vs. turned away), so a release
        routes even on a fresh install. With no face, or a head between the two
        screens, there is no target and the window stays put — guessing is worse
        than leaving it where it is.
        """
        if self.target not in TARGETS:
            return None
        return self.target

    @property
    def uses_default(self) -> bool:
        """True when routing is the uncalibrated camera-relative default."""
        return self.calibration is None

    def snapshot(self) -> dict[str, Any]:
        calibration = self.calibration
        usable = calibration is not None and calibration.is_usable()
        return {
            "target": self.target,
            "releaseTarget": self.release_target(),
            "mode": "calibrated" if usable else "default" if calibration is None else "invalid",
            "yaw": None if self.yaw is None else round(self.yaw, 1),
            "calibrated": usable,
            "laptopYaw": round(calibration.yaw_laptop, 1) if usable else None,
            "tabletYaw": round(calibration.yaw_tablet, 1) if usable else None,
            "samples": self.samples,
        }
