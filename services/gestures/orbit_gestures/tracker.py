"""Camera capture and MediaPipe landmark extraction.

Runs entirely on this laptop. No frame, landmark or image ever leaves the
device — the only thing that goes over the wire is a small JSON status message.

Model files are downloaded once into `models/` and cached. They are the official
MediaPipe float16 bundles.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions

from .geometry import swap_handedness

MODELS = {
    "hand": (
        "hand_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    ),
    "face": (
        "face_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    ),
}


@dataclass
class FrameResult:
    """What one processed frame produced."""

    hands: list[list[Any]] = field(default_factory=list)
    world_hands: list[list[Any]] = field(default_factory=list)
    """Metric 3D landmarks in metres, origin at the hand's centre.

    The normalised `hands` are 2D-plus-relative-depth in image space, which is not
    enough to know which way the palm faces. These are real 3D, so the palm's
    surface normal can be computed and a ray cast from it.
    """
    faces: list[list[Any]] = field(default_factory=list)
    face_matrices: list[Any] = field(default_factory=list)
    """Per-face 4x4 pose matrix, aligned with ``faces``.

    Maps MediaPipe's canonical face model into camera space, so its third column
    is the direction the face is pointing. This is the only reliable way to get
    a head *orientation* — landmark positions give a shape, not a pose, and a
    face turned to the side looks much like a narrower face.
    """
    hand_labels: list[str] = field(default_factory=list)
    """MediaPipe's handedness label per detected hand, e.g. ``"Right"``.

    Aligned with ``hands`` and ``world_hands``. The pointer follows the right
    palm specifically, so the caller needs to know which entry is which rather
    than assuming index 0.
    """
    hand_scores: list[float] = field(default_factory=list)
    """Confidence of each hand, aligned with ``hand_labels``."""
    hand_confidence: float = 0.0
    face_confidence: float = 0.0
    width: int = 0
    height: int = 0
    success: bool = False
    frame_mean: float = 0.0
    """Mean brightness (0-255) of the frame the landmarkers just saw.

    Windows can hand a process a stream that reads successfully but contains
    nothing but black frames — typically when another app still holds the camera
    at the moment we open it. MediaPipe then finds no hand and no face, which is
    indistinguishable from "nobody is at the desk" unless the frame itself is
    measured. The service watches this value and reopens the device when it
    stays at zero.
    """


def ensure_models(models_dir: Path) -> dict[str, Path]:
    """Download model bundles on first use, atomically, and cache them."""
    import urllib.request

    models_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for key, (filename, url) in MODELS.items():
        target = models_dir / filename
        paths[key] = target
        if target.exists() and target.stat().st_size > 100_000:
            continue
        tmp = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 - fixed official URL
            data = response.read()
        if len(data) < 100_000:
            raise RuntimeError(f"Model download for {key} looked truncated ({len(data)} bytes)")
        tmp.write_bytes(data)
        tmp.replace(target)
    return paths


class Tracker:
    """Owns the camera and both landmarkers."""

    def __init__(self, models_dir: Path, camera_index: int = 0) -> None:
        self.paths = ensure_models(models_dir)
        hand_opts = vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(self.paths["hand"])),
            running_mode=vision.RunningMode.VIDEO,
            # Two hands, not one: the pointer is bound to the *right* palm, so
            # the left hand has to be visible to the detector in order for the
            # right one to be identified and chosen. Asking for one hand meant
            # the model simply returned whichever scored highest — often the
            # resting left hand — and the cursor followed the wrong limb.
            num_hands=2,
            min_hand_detection_confidence=0.45,
            min_hand_presence_confidence=0.45,
            min_tracking_confidence=0.45,
        )
        face_opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(self.paths["face"])),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            # Head pose for gaze routing. Cheap — the matrix falls out of the
            # fit the landmarker has already done — and it is the only way to
            # tell which screen the user has turned to look at.
            output_facial_transformation_matrixes=True,
        )
        self.hand = vision.HandLandmarker.create_from_options(hand_opts)
        self.face = vision.FaceLandmarker.create_from_options(face_opts)

        self.capture = self._open_camera(camera_index)
        if self.capture is None:
            # Windows gives a webcam to one process at a time. The most common
            # cause is a hidden leftover process (often an earlier ORBIT
            # service) still holding the device, which is not obvious from the
            # privacy-settings wording, so name the possibilities instead of
            # asserting one.
            raise RuntimeError(
                f"Could not open camera {camera_index}. Windows returned no usable stream "
                "after trying DirectShow and Media Foundation. The device may be held by "
                "another app or a leftover ORBIT service (Zoom, Teams, a browser tab), "
                "disabled in Settings > Privacy > Camera, or disconnected. Close other "
                "camera apps, then press Restart camera."
            )

        self.camera_index = camera_index
        self._configure_capture(self.capture)
        self._start = time.monotonic()
        # Handedness labels from the previous frame, per detected hand slot.
        # Some frames omit the category while still returning landmarks; the
        # hand must not lose its identity (and the pointer its control) there.
        self._last_labels: list[str] = []
        self._last_scores: list[float] = []

    @staticmethod
    def _configure_capture(capture: cv2.VideoCapture) -> None:
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        capture.set(cv2.CAP_PROP_FPS, 30)

    def reopen_camera(self) -> bool:
        """Release and reopen the capture device; True when a stream is open.

        A stream opened while another process was still releasing the camera can
        read successfully but deliver only black frames for as long as it lives.
        Closing and reopening once the other app has let go recovers it. The
        MediaPipe video timestamps are left alone: they must keep increasing
        across a reopen or `detect_for_video` rejects the frame.
        """
        try:
            self.capture.release()
        except Exception:  # noqa: BLE001 - a dead device must not block the retry
            pass
        capture = self._open_camera(self.camera_index)
        if capture is None:
            return False
        self._configure_capture(capture)
        self.capture = capture
        return True

    @staticmethod
    def _open_camera(index: int) -> cv2.VideoCapture | None:
        """Open the webcam with a short retry across Windows backends.

        DirectShow is the reliable path on Windows, but a device that has just
        been released by another process sometimes fails the first attempt and
        succeeds moments later. Trying Media Foundation and the platform default
        as well means a single backend quirk does not present as "camera busy".
        """
        backends = []
        for name in ("CAP_DSHOW", "CAP_MSMF"):
            value = getattr(cv2, name, None)
            if value is not None:
                backends.append(value)
        backends.append(cv2.CAP_ANY)

        for backend in backends:
            for _ in range(2):
                capture = cv2.VideoCapture(index, backend)
                if capture.isOpened():
                    return capture
                capture.release()
                # Give a process that is mid-release a moment to let go.
                time.sleep(0.35)
        return None

    def read(self) -> tuple[np.ndarray | None, FrameResult]:
        ok, frame = self.capture.read()
        if not ok or frame is None:
            return None, FrameResult()

        # Mirror so the preview matches the user's expectation and left/right
        # mapping is intuitive if we add handed calibration later.
        frame = cv2.flip(frame, 1)
        # Cheap frame-health signal. A black stream still returns ok=True, so
        # this is the only way to tell "camera delivered nothing" from "nobody
        # is in front of it".
        frame_mean = float(frame.mean())
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))

        timestamp_ms = int((time.monotonic() - self._start) * 1000)
        hands_result = self.hand.detect_for_video(image, timestamp_ms)
        face_result = self.face.detect_for_video(image, timestamp_ms)

        hands = [
            [(lm.x, lm.y, lm.z) for lm in hand]
            for hand in (hands_result.hand_landmarks or [])
        ]
        world_hands = [
            [(lm.x, lm.y, lm.z) for lm in hand]
            for hand in (hands_result.hand_world_landmarks or [])
        ]
        faces = [
            [(lm.x, lm.y, lm.z) for lm in face]
            for face in (face_result.face_landmarks or [])
        ]
        # Older MediaPipe builds do not expose the attribute at all, and it is
        # absent when no face was found, so both cases have to fall back to an
        # empty list rather than raising on every frame.
        matrices = [
            np.asarray(m, dtype=float).reshape(4, 4).tolist()
            for m in (getattr(face_result, "facial_transformation_matrixes", None) or [])
        ]

        hand_labels: list[str] = []
        hand_scores: list[float] = []
        for entry in hands_result.handedness or []:
            # MediaPipe returns a list of categories per hand; the first is the
            # winner. The Task API sometimes returns a hand with an empty
            # category on a marginal frame — seen on this laptop as
            # `label='Right'` for one frame and `label=''` for the next ten.
            if entry and entry[0].category_name:
                hand_labels.append(str(entry[0].category_name))
                hand_scores.append(float(entry[0].score))
            else:
                hand_labels.append("")
                hand_scores.append(0.0)

        # Carry a missing label *and* its score forward per slot. MediaPipe is
        # still returning full landmarks for that hand; only the handedness
        # classifier omitted its answer. Dropping control on those frames reset
        # every hold — the pinch had to be re-earned, the 450 ms fist hold never
        # completed, and the scroll accumulator restarted before it could reach
        # a notch.
        for index, label in enumerate(hand_labels):
            if (
                not label
                and index < len(self._last_labels)
                and index < len(self._last_scores)
            ):
                hand_labels[index] = self._last_labels[index]
                hand_scores[index] = self._last_scores[index]
        self._last_labels = list(hand_labels)
        self._last_scores = list(hand_scores)

        # Undo the mirror for the labels. MediaPipe's Task API reports handedness
        # for the *subject's* hands and explicitly documents that a horizontally
        # mirrored input inverts Left/Right. Because `cv2.flip` above mirrors the
        # frame, the user's right hand arrives labelled "Left"; the pointer then
        # followed the left hand and ignored the right one entirely.
        hand_labels = swap_handedness(hand_labels)

        # Confidence here means "there is a hand", not "the handedness category
        # was named". The category score is 0 whenever MediaPipe omits the label,
        # and treating that as low confidence made the machine declare
        # tracking lost on half the frames while the hand was perfectly visible —
        # which ended the window grab through ipc on almost every frame.
        hand_conf = 1.0 if hands else 0.0

        # FaceLandmarker does not emit a per-face score unless blendshapes are
        # enabled, which we do not need. Presence is the signal we care about;
        # a detected face means the landmarker was confident enough to emit one.
        face_conf = 1.0 if faces else 0.0

        height, width = frame.shape[:2]
        return frame, FrameResult(
            hands=hands,
            world_hands=world_hands,
            faces=faces,
            face_matrices=matrices,
            hand_labels=hand_labels,
            hand_scores=hand_scores,
            hand_confidence=hand_conf,
            face_confidence=face_conf,
            width=width,
            height=height,
            success=True,
            frame_mean=frame_mean,
        )

    def release(self) -> None:
        try:
            self.capture.release()
        finally:
            self.hand.close()
            self.face.close()
