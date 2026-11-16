/**
 * On-device hand and face tracking for the iPad.
 *
 * The laptop already runs MediaPipe against its own webcam. This hook gives the
 * iPad the same capability locally: its camera feed is decoded in Safari and
 * never leaves the device. Only four small results cross the socket — pointer
 * position, pinch press/release, a "the user is looking at me" flag, and whether
 * the hand in front is a fist — so the laptop can hand control over without
 * needing to see the iPad.
 *
 * MediaPipe's WASM runtime and both task models are served by the ORBIT server
 * from `/mediapipe/`. They are copied into the receiver build by
 * `scripts/prepare-mediapipe.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Why this file is written the way it is
 *
 * The previous version ran *both* landmarkers on every decoded camera frame on
 * the main thread, and reacted to every single frame's result as if it were the
 * truth. Three consequences, all reported as "the tracking is glitchy and not as
 * good as the laptop":
 *
 *  1. Two full inferences per frame (a hand model, and every 120 ms a full face
 *     mesh) starved the main thread that also has to draw the cursor and run
 *     React. The cursor trailed the hand no matter how good the detection was.
 *  2. Every frame's gaze reading went straight out over the socket with no
 *     smoothing, no hysteresis and no dwell, so a single noisy angular reading
 *     flipped the ownership of the screen. The chip flickered and, worse, the
 *     laptop's idea of which screen the user was on flickered with it.
 *  3. One dropped hand frame hid the cursor and released a held pinch. At 24 fps
 *     with a hand model that occasionally misses, that is a cursor that
 *     disappears and clicks that do not register.
 *
 * So: the face model now runs at a low, fixed rate and the hand model only runs
 * when someone is actually looking at the iPad and could be pointing at it;
 * gaze goes through a smoothed, hysteretic, dwell-filtered decision; and losing
 * a hand for a couple of frames is treated as a moment of doubt rather than as
 * the end of the gesture. Every one of those numbers is deliberate and commented
 * where it is chosen.
 */

import { useEffect, useRef, useState } from 'react';
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

const WASM_PATH = '/mediapipe/wasm';
const HAND_MODEL = '/mediapipe/models/hand_landmarker.task';
const FACE_MODEL = '/mediapipe/models/face_landmarker.task';

/**
 * How often the face is read.
 *
 * Head pose is a slow signal (the head takes a quarter of a second to turn), and
 * the face mesh is the single most expensive thing on this device, so 150 ms is
 * plenty: six readings a second, each of which is smoothed and dwelled anyway.
 */
const FACE_INTERVAL_MS = 150;
/** Time constant for the head-yaw filter, in ms. Shorter = twitchier. */
const YAW_TAU_MS = 100;
/** At most this far off-axis to *claim* the user is looking at the iPad. */
const LOOKING_ENTER_DEG = 22;
/** Must exceed this to *stop* believing it: the gap between the two is the
 * hysteresis band, so a head resting on the threshold cannot flicker. */
const LOOKING_EXIT_DEG = 32;
/** An opinion must survive this long before it is allowed to change. */
const GAZE_DWELL_MS = 120;
/**
 * A face that vanishes for this long stops being "looking", and no sooner.
 *
 * Short enough to hand control back quickly when the user turns to the laptop -
 * the laptop will not move its cursor while the iPad still claims ownership, and
 * a second of that reads as "the pointer is stuck" - but long enough to ride out
 * a blink, a hand passing in front of the face, or a single dropped detection.
 */
const GAZE_FACE_GRACE_MS = 600;
/** How often an unchanged gaze opinion is repeated, so the laptop sees it fresh. */
const GAZE_REPORT_MS = 800;
/** A face smaller than this is too far away to be the person at the iPad. */
const MIN_FACE_WIDTH = 0.05;

/** A pinch must settle this long before it presses, matching the laptop. */
const PINCH_SETTLE_MS = 60;
/** Thumb/index separation, in hand widths, that opens and closes the pinch. */
const PINCH_ON = 0.45;
const PINCH_OFF = 0.6;
/** A hand missing for less than this does not release a held pinch. */
const PINCH_LOST_GRACE_MS = 220;

/** Curl at which an open hand becomes a fist, and a fist becomes an open hand. */
const FIST_ENTER = 0.58;
const FIST_EXIT = 0.42;
/** A fist that leaves the frame for this long counts as having opened. */
const FIST_LOST_GRACE_MS = 600;

// How far the hand must travel to cross the whole screen.
//
// Reported: "the cursor on the iPad has only a range of the right half of the
// screen. Pretty glitchy."
//
// At 2.5, a hand travel of only +/-0.2 in normalised camera space already pinned
// the cursor to an edge. Real hand motion over a comfortable range is nearer 0.4,
// so the cursor saturated almost immediately: it slammed side to side on small
// movements (the "glitchy" part) and spent its life against one edge, which reads
// as "it only covers half the screen".
//
// 1.4 means roughly +/-0.35 of hand travel spans the full width: the same
// comfortable sweep the laptop pointer uses, with headroom so the edges are
// reachable deliberately rather than accidentally.
const GAIN_X = 1.4;
const GAIN_Y = 1.5;
// Lighter smoothing than before. Heavy smoothing on top of an over-amplified
// signal is what made it feel both twitchy and laggy at once.
const SMOOTHING = 0.6;
// A genuine jump guard, not a governor. At 0.55 a real fast movement was being
// discarded outright, so the cursor would freeze mid-sweep.
const MAX_JUMP = 0.85;
/** Below this distance from the learned centre, the hand counts as still. */
const DEAD_ZONE = 0.014;
/**
 * How long the cursor stays on screen after the last frame that placed it.
 *
 * A hand model that misses one frame in twenty should not make the cursor blink,
 * and a pinch in flight should not be torn out from under the user. The cursor
 * is hidden once the hand has really gone, not on the first frame it is missing.
 */
const POINTER_HOLD_MS = 260;

type Normalized = { x: number; y: number; z: number };

export interface TabletTrackingOptions {
  /** Called on pinch settle with the cursor position in [0, 1]. */
  onDown: (x: number, y: number) => void;
  /** Called when the pinch opens, wherever the cursor then is. */
  onUp: (x: number, y: number) => void;
  /**
   * `true` = facing the iPad, `false` = turned away, `null` = no opinion.
   *
   * Delivered only when it changes, plus a repeat every `GAZE_REPORT_MS` so the
   * laptop can tell a live opinion from a dead socket.
   */
  onGaze: (looking: boolean | null) => void;
  /**
   * Cursor position as a fraction of the viewport, or `null` to hide it.
   *
   * A callback rather than React state on purpose: this fires at the camera's
   * frame rate, and re-rendering the whole workspace 24 times a second on an
   * iPad is exactly the kind of main-thread work that made the cursor lag its
   * hand. The consumer moves a DOM node instead.
   */
  onPointer?: (pointer: { x: number; y: number } | null) => void;
  /**
   * Whether the hand in front of the iPad is closed.
   *
   * The laptop cannot answer this once the user has turned their head to the
   * iPad — its webcam has no face in view, so it emits no gestures at all. The
   * transfer gesture is "hold a fist, turn to the iPad, open the hand", so this
   * is the only report of the second half of it.
   */
  onFist?: (fist: boolean) => void;
}

export interface TabletTracking {
  state: 'off' | 'starting' | 'running' | 'failed';
  error: string | null;
  /** The last gaze opinion, for the status chip. */
  looking: boolean | null;
  /** Must be called from a user gesture so Safari allows the camera. */
  start: () => void;
  stop: () => void;
}

const HAND_INDEX_MCP = 5;
const HAND_PINKY_MCP = 17;
const HAND_THUMB_TIP = 4;
const HAND_INDEX_TIP = 8;
const HAND_PINKY_TIP = 20;
const FINGER_CHAINS: ReadonlyArray<readonly [number, number, number]> = [
  [HAND_INDEX_MCP, 6, HAND_INDEX_TIP],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, HAND_PINKY_TIP],
];
const FACE_LEFT_CHEEK = 234;
const FACE_RIGHT_CHEEK = 454;

function distance(a: Normalized, b: Normalized): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Silhouette of the hand, mirrored so moving right on screen means moving right. */
function mirrored(landmarks: Normalized[]): Normalized[] {
  return landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
}

function handWidth(hand: Normalized[]): number {
  if (hand.length <= HAND_PINKY_MCP) return 0;
  return distance(hand[HAND_INDEX_MCP]!, hand[HAND_PINKY_MCP]!);
}

/** Thumb-tip to index-tip distance, normalised so it is size independent. */
function pinchDistance(hand: Normalized[]): number {
  const width = handWidth(hand);
  if (width <= 1e-6 || hand.length <= HAND_INDEX_TIP) return Number.POSITIVE_INFINITY;
  return distance(hand[HAND_THUMB_TIP]!, hand[HAND_INDEX_TIP]!) / width;
}

/** 0 = open hand, 1 = fist. Same measure as the laptop's geometry module. */
function fingerCurl(hand: Normalized[]): number {
  if (hand.length <= HAND_PINKY_TIP) return 0;
  const curls: number[] = [];
  for (const [mcpIndex, pipIndex, tipIndex] of FINGER_CHAINS) {
    const mcp = hand[mcpIndex]!;
    const pip = hand[pipIndex]!;
    const tip = hand[tipIndex]!;
    const bone = distance(mcp, pip);
    if (bone <= 1e-6) continue;
    const span = distance(mcp, tip);
    curls.push((1.9 - span / bone) / (1.9 - 0.65));
  }
  if (curls.length === 0) return 0;
  const mean = curls.reduce((sum, value) => sum + value, 0) / curls.length;
  return Math.min(1, Math.max(0, mean));
}

/** Palm centre: rigid while the fingers pinch, unlike a fingertip. */
function palmCentre(hand: Normalized[]): { x: number; y: number } | null {
  if (hand.length <= Math.max(HAND_INDEX_MCP, HAND_PINKY_MCP)) return null;
  const a = hand[HAND_INDEX_MCP]!;
  const b = hand[HAND_PINKY_MCP]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Head yaw from a MediaPipe facial transformation matrix.
 *
 * The third column is the face's forward axis. The matrix is a row-major 4x4 in
 * MediaPipe's proto, so that column is data[2], data[6], data[10]. Measuring the
 * angle of that vector avoids composing Euler angles by hand.
 */
function headYaw(matrix: { rows: number; columns: number; data: number[] } | undefined): number | null {
  if (!matrix || matrix.data.length < matrix.rows * matrix.columns || matrix.columns < 3) return null;
  const at = (row: number, col: number): number => matrix.data[row * matrix.columns + col] ?? 0;
  const fx = at(0, 2);
  const fy = at(1, 2);
  const fz = at(2, 2);
  const norm = Math.hypot(fx, fy, fz);
  if (norm < 1e-6) return null;
  return (Math.atan2(fx / norm, fz / norm) * 180) / Math.PI;
}

function faceWidth(landmarks: Normalized[]): number {
  if (landmarks.length <= Math.max(FACE_LEFT_CHEEK, FACE_RIGHT_CHEEK)) return 0;
  return distance(landmarks[FACE_LEFT_CHEEK]!, landmarks[FACE_RIGHT_CHEEK]!);
}

export function useTabletTracking(options: TabletTrackingOptions): TabletTracking {
  const [state, setState] = useState<TabletTracking['state']>('off');
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState<boolean | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handRef = useRef<HandLandmarker | null>(null);
  const faceRef = useRef<FaceLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const startTokenRef = useRef(0);
  const videoFrameRef = useRef<number | null>(null);
  /** `video.currentTime` of the last frame the models actually ran on. */
  const lastVideoTimeRef = useRef<number>(-1);
  /** Clears the "tap anywhere to start" listener once tracking is live. */
  const detachTouchRef = useRef<() => void>(() => {});

  /** Centre of the usable box, learned from where the hand first rests. */
  const centreRef = useRef<{ x: number; y: number } | null>(null);
  const centreSamplesRef = useRef<Array<{ x: number; y: number }>>([]);
  const smoothRef = useRef<{ x: number; y: number } | null>(null);
  const lastHandAtRef = useRef(0);
  const lastFaceAtRef = useRef(0);

  /** The gaze decision, and the evidence it is built from. */
  const gazeRef = useRef({
    /** Smoothed head yaw in degrees, or null before the first face. */
    yaw: null as number | null,
    /** The committed opinion. Only ever changes through the dwell below. */
    opinion: null as boolean | null,
    /** The value the raw reading currently points at. */
    candidate: null as boolean | null,
    candidateSince: 0,
    lastFaceAt: 0,
  });
  /** Reports an opinion, at most once per `GAZE_REPORT_MS` when unchanged. */
  const lastGazeSentAtRef = useRef(0);

  const pinchRef = useRef({ active: false, since: 0, pressed: false, wasPinching: false });
  /** When the hand went missing while a pinch was held. 0 = hand present. */
  const pinchLostAtRef = useRef(0);

  /** Whether the hand is *believed* to be a fist right now. */
  const fistRef = useRef(false);
  /**
   * What the laptop has actually been told, so a state is never re-sent.
   *
   * Reset to `null` whenever the iPad becomes the screen the user is looking at,
   * which forces the first frame of the new ownership to report itself. The
   * carry gesture depends on that first report: if the user turns to the iPad
   * and opens their hand within a couple of frames, the laptop never sees a
   * "fist" from this camera at all - only the open hand, which is still the
   * answer it needs.
   */
  const lastFistSentRef = useRef<boolean | null>(null);
  /** When the hand went missing while a fist was believed held. 0 = present. */
  const fistLostAtRef = useRef(0);

  /** The cursor's current position, and when it was last placed. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const pointerAtRef = useRef(0);

  // -- output -------------------------------------------------------------

  const reportGaze = (value: boolean | null, force: boolean): void => {
    const now = performance.now();
    const changed = gazeRef.current.opinion !== value;
    // Repeat an unchanged opinion on the clock, so the laptop can tell a live
    // tracker from a disconnected one; send any change at once.
    if (!force && !changed && now - lastGazeSentAtRef.current < GAZE_REPORT_MS) return;
    lastGazeSentAtRef.current = now;
    if (changed) {
      gazeRef.current.opinion = value;
      // A new ownership starts a new hand report: see `lastFistSentRef`.
      if (value !== null) lastFistSentRef.current = null;
      setLooking(value);
    }
    optionsRef.current.onGaze(value);
  };

  /**
   * Tell the laptop whether the hand in front of the iPad is closed.
   *
   * Sent on every transition, and once more whenever this device takes over as
   * the screen being looked at - the laptop uses the *open* report to finish a
   * window carry, so a stale "nothing to say" is the difference between the
   * window moving and the gesture silently doing nothing.
   */
  const reportFist = (fist: boolean): void => {
    if (lastFistSentRef.current === fist) return;
    lastFistSentRef.current = fist;
    optionsRef.current.onFist?.(fist);
  };

  const placePointer = (next: { x: number; y: number }): void => {
    pointerRef.current = next;
    pointerAtRef.current = performance.now();
    optionsRef.current.onPointer?.(next);
  };

  /**
   * Hide the cursor, but only once it has really gone.
   *
   * A hand model at 24 fps misses frames, and hiding on the first miss made the
   * cursor blink and broke a pinch that was held through it.
   */
  const clearPointer = (now: number): void => {
    if (!pointerRef.current) return;
    if (now - pointerAtRef.current < POINTER_HOLD_MS) return;
    pointerRef.current = null;
    optionsRef.current.onPointer?.(null);
  };

  const releasePinch = (x: number, y: number): void => {
    const pinch = pinchRef.current;
    if (!pinch.pressed) return;
    pinch.pressed = false;
    optionsRef.current.onUp(x, y);
  };

  /**
   * Fold a head-yaw reading into the gaze decision.
   *
   * Three stages, in the order they protect against a wrong answer:
   *  1. exponential smoothing, so landmark noise does not reach the decision;
   *  2. hysteresis, so a head resting on the threshold cannot flicker;
   *  3. a dwell, so only a sustained turn changes which screen owns control.
   */
  const observeGaze = (now: number, yaw: number | null): void => {
    const gaze = gazeRef.current;

    if (yaw === null) {
      // No face this pass. That is a moment of doubt, not a decision: the head
      // may simply be out of frame for a frame. Only a sustained absence means
      // the user has really turned away.
      if (gaze.lastFaceAt === 0) return;
      if (now - gaze.lastFaceAt < GAZE_FACE_GRACE_MS) return;
      gaze.yaw = null;
      gaze.candidate = null;
      gaze.candidateSince = 0;
      if (gaze.opinion !== null) reportGaze(null, true);
      return;
    }

    const gap = gaze.lastFaceAt === 0 ? FACE_INTERVAL_MS : Math.max(1, now - gaze.lastFaceAt);
    gaze.lastFaceAt = now;
    const alpha = 1 - Math.exp(-gap / YAW_TAU_MS);
    gaze.yaw = gaze.yaw === null ? yaw : gaze.yaw + (yaw - gaze.yaw) * alpha;

    // Asymmetric on purpose: entering needs the head genuinely facing the iPad,
    // leaving needs it genuinely turned away. The band between the two absorbs
    // the reading that sits exactly on one number.
    const limit = gaze.opinion === true ? LOOKING_EXIT_DEG : LOOKING_ENTER_DEG;
    const candidate = Math.abs(gaze.yaw) <= limit;
    if (candidate !== gaze.candidate) {
      gaze.candidate = candidate;
      gaze.candidateSince = now;
    }
    // The first opinion is taken at once, so the screen is usable immediately;
    // later changes have to earn a dwell.
    const dwell = gaze.opinion === null ? 0 : GAZE_DWELL_MS;
    if (gaze.opinion !== candidate && now - gaze.candidateSince >= dwell) {
      reportGaze(candidate, true);
      return;
    }
    // Nothing changed: repeat the standing opinion on the clock so the laptop
    // can tell a live tracker from a disconnected one.
    if (gaze.opinion !== null) reportGaze(gaze.opinion, false);
  };

  const stop = (): void => {
    runningRef.current = false;
    startTokenRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const video = videoRef.current;
    if (video && videoFrameRef.current !== null) {
      video.cancelVideoFrameCallback?.(videoFrameRef.current);
      videoFrameRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    videoRef.current = null;
    if (video) {
      video.srcObject = null;
      // Detach it: a hidden video that stays in the DOM keeps an iOS decoding
      // session alive even after its tracks have stopped.
      video.parentNode?.removeChild(video);
    }
    handRef.current?.close();
    faceRef.current?.close();
    handRef.current = null;
    faceRef.current = null;

    const smooth = smoothRef.current;
    if (smooth && pinchRef.current.pressed) {
      pinchRef.current.pressed = false;
      optionsRef.current.onUp(smooth.x, smooth.y);
    }
    pinchRef.current = { active: false, since: 0, pressed: false, wasPinching: false };
    pinchLostAtRef.current = 0;
    centreRef.current = null;
    centreSamplesRef.current = [];
    smoothRef.current = null;
    lastHandAtRef.current = 0;
    lastFaceAtRef.current = 0;
    gazeRef.current = {
      yaw: null,
      opinion: null,
      candidate: null,
      candidateSince: 0,
      lastFaceAt: 0,
    };
    lastGazeSentAtRef.current = 0;
    fistRef.current = false;
    lastFistSentRef.current = null;
    fistLostAtRef.current = 0;
    pointerRef.current = null;
    pointerAtRef.current = 0;
    // Deliberately *not* `onFist(false)`: stopping the camera is not the user
    // opening their hand. Reporting it would send a window to this iPad because
    // the page happened to reload mid-carry. The carry instead waits for a real
    // release, or for the laptop's timeout.
    optionsRef.current.onPointer?.(null);
    // Tell the laptop to stop treating the iPad as the owner.
    optionsRef.current.onGaze(null);
    setLooking(null);
    setState('off');
    setError(null);
  };

  const createLandmarkers = async (): Promise<{ hand: HandLandmarker; face: FaceLandmarker }> => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const build = async (delegate: 'GPU' | 'CPU'): Promise<{ hand: HandLandmarker; face: FaceLandmarker }> => {
      const hand = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        const face = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
        });
        return { hand, face };
      } catch (err) {
        hand.close();
        throw err;
      }
    };

    try {
      return await build('GPU');
    } catch {
      // Older iPads, or a Safari build with a broken WebGL context, fall back
      // to CPU. Slower, but a working pointer beats a perfect delegate.
      return await build('CPU');
    }
  };

  const detect = (video: HTMLVideoElement, now: number): void => {
    const handLandmarker = handRef.current;
    const faceLandmarker = faceRef.current;
    if (!handLandmarker || !faceLandmarker || video.readyState < 2) return;

    // Never infer twice on the same camera frame.
    //
    // MediaPipe's VIDEO mode expects one call per decoded frame. Feeding it the
    // same frame again returns the same result but costs a full inference on the
    // main thread, and it also advances its internal timestamp tracking for a
    // frame that did not change - which is what made tracking feel insensitive
    // and late rather than merely slow.
    if (video.currentTime === lastVideoTimeRef.current) return;
    lastVideoTimeRef.current = video.currentTime;

    // -- face: which screen, and is a face even there ----------------------
    //
    // Read on its own slow clock. Doing this every frame was half the main
    // thread's budget for a signal that moves over hundreds of milliseconds.
    if (now - lastFaceAtRef.current >= FACE_INTERVAL_MS) {
      lastFaceAtRef.current = now;
      let faceResult: FaceLandmarkerResult | null = null;
      try {
        faceResult = faceLandmarker.detectForVideo(video, now);
      } catch {
        /* treat as no face this pass */
      }
      if (faceResult) {
        const face = faceResult.faceLandmarks[0];
        const matrix = faceResult.facialTransformationMatrixes[0];
        const yaw = headYaw(matrix);
        // No face, or a face too small/far away, is "no opinion" - the gaze
        // filter above decides how long that is tolerated.
        if (!face || face.length === 0 || faceWidth(face) < MIN_FACE_WIDTH || yaw === null) {
          observeGaze(now, null);
        } else {
          observeGaze(now, yaw);
        }
      }
    }

    // -- hand: only when it can possibly matter ----------------------------
    //
    // The cursor only exists on the iPad while the user is facing it, so running
    // a hand model while they look at the laptop was pure main-thread cost with
    // no possible result. The exception is a hand *believed* to be a fist: that
    // is half of the window-carry gesture, and its other half (the hand opening)
    // is the one event the laptop cannot see for itself.
    const wantHand = gazeRef.current.opinion === true || fistRef.current;
    if (!wantHand) {
      // Nobody is looking at this screen, so there is no cursor and no gesture.
      // A pinch that was held when the head turned away must not stay pressed on
      // the page underneath - it would be a mouse button held down by an absent
      // hand, and the next tap would arrive as a drag.
      const last = smoothRef.current;
      if (last && pinchRef.current.pressed) releasePinch(last.x, last.y);
      pinchRef.current.active = false;
      pinchRef.current.wasPinching = false;
      pinchLostAtRef.current = 0;
      clearPointer(now);
      return;
    }

    let handResult: HandLandmarkerResult | null = null;
    try {
      handResult = handLandmarker.detectForVideo(video, now);
    } catch {
      /* a missed frame is normal while the camera warms up */
    }

    const rawHand = handResult?.landmarks[0];
    if (!rawHand || rawHand.length === 0) {
      // A missing hand is a moment of doubt while a pinch or a fist is in
      // flight, and an ending only after that grace has passed.
      if (pinchRef.current.pressed) {
        if (pinchLostAtRef.current === 0) pinchLostAtRef.current = now;
        const last = smoothRef.current;
        if (now - pinchLostAtRef.current >= PINCH_LOST_GRACE_MS && last) {
          releasePinch(last.x, last.y);
        }
      } else {
        pinchLostAtRef.current = 0;
        pinchRef.current.active = false;
        pinchRef.current.wasPinching = false;
      }
      if (fistRef.current) {
        if (fistLostAtRef.current === 0) fistLostAtRef.current = now;
        if (now - fistLostAtRef.current >= FIST_LOST_GRACE_MS) {
          fistLostAtRef.current = 0;
          reportFist(false);
        }
      }
      clearPointer(now);
      return;
    }

    fistLostAtRef.current = 0;
    pinchLostAtRef.current = 0;

    // Only the user facing the iPad may drive it. When they turn to the laptop
    // we hide the cursor and end any drag rather than acting on hand motion the
    // laptop should own.
    if (gazeRef.current.opinion !== true) {
      const smooth = smoothRef.current;
      if (smooth) releasePinch(smooth.x, smooth.y);
      pinchRef.current.active = false;
      pinchRef.current.wasPinching = false;
      clearPointer(now);
      return;
    }

    const hand = mirrored(rawHand);
    const palm = palmCentre(hand);
    if (!palm) {
      clearPointer(now);
      return;
    }

    // -- fist: reported on change, so the laptop can finish a carry ---------
    const curl = fingerCurl(hand);
    const isFist = curl >= (fistRef.current ? FIST_EXIT : FIST_ENTER);
    fistRef.current = isFist;
    // A fist is not a pointer gesture, but it still has to be reported: it is
    // half of the window-carry gesture. The pointer keeps following the palm in
    // the same frame, so opening the hand does not lose the cursor.
    reportFist(isFist);

    // Learn the neutral point from the first stationary frames. Without it the
    // cursor would start wherever the arm happens to rest, usually a corner.
    if (!centreRef.current) {
      centreSamplesRef.current.push(palm);
      // Reject a calibration taken while the hand was moving.
      //
      // The neutral point was learned from whichever eight frames happened to
      // arrive first, including ones caught mid-swing. A centre learned off to
      // one side shifts the whole usable range with it - which is the other way
      // "the cursor only covers half the screen" can happen. Requiring the
      // samples to be tightly clustered keeps the learned centre where the hand
      // actually rests.
      if (centreSamplesRef.current.length >= 8) {
        const xs = centreSamplesRef.current.map((p) => p.x).sort((a, b) => a - b);
        const ys = centreSamplesRef.current.map((p) => p.y).sort((a, b) => a - b);
        const midX = xs[Math.floor(xs.length / 2)]!;
        const midY = ys[Math.floor(ys.length / 2)]!;
        const spread = Math.max(xs[xs.length - 1]! - xs[0]!, ys[ys.length - 1]! - ys[0]!);
        if (spread <= 0.08) {
          centreRef.current = { x: midX, y: midY };
          centreSamplesRef.current = [];
        } else {
          // Hand was moving: drop the oldest half and keep sampling.
          centreSamplesRef.current = centreSamplesRef.current.slice(4);
        }
      }
    }
    // Sans a learned centre, start from the middle of the frame rather than a
    // guess at where the arm rests.
    const centre = centreRef.current ?? { x: 0.5, y: 0.5 };

    // A small dead zone around the learned centre.
    //
    // Without it, landmark noise of a few percent kept the cursor in constant
    // sub-pixel motion even with a still hand, which is what read as "glitchy".
    // Anything inside the radius is treated as "still centred"; past it the
    // dead zone is subtracted so movement away from centre stays 1:1 and there
    // is no jump when it engages.
    const shift = (value: number): number => {
      const magnitude = Math.abs(value);
      if (magnitude <= DEAD_ZONE) return 0;
      return Math.sign(value) * (magnitude - DEAD_ZONE);
    };
    const dx = shift(palm.x - centre.x);
    const dy = shift(palm.y - centre.y);
    const target = {
      x: Math.min(1, Math.max(0, 0.5 + dx * GAIN_X)),
      y: Math.min(1, Math.max(0, 0.5 + dy * GAIN_Y)),
    };

    // Time-based exponential smoothing with a jump guard, matching the laptop.
    const previous = smoothRef.current;
    let next = target;
    if (previous) {
      const gap = now - lastHandAtRef.current;
      const jump = Math.hypot(target.x - previous.x, target.y - previous.y);
      if (jump <= MAX_JUMP || gap > 250) {
        const factor = gap > 0 ? 1 - (1 - SMOOTHING) ** (gap / (1000 / 30)) : SMOOTHING;
        next = {
          x: previous.x + (target.x - previous.x) * factor,
          y: previous.y + (target.y - previous.y) * factor,
        };
      } else {
        next = previous;
      }
    }
    lastHandAtRef.current = now;
    smoothRef.current = next;
    placePointer(next);

    const width = handWidth(hand);
    const pinch = pinchRef.current;
    const distanceNow = width > 0 ? pinchDistance(hand) : Number.POSITIVE_INFINITY;
    const pinching = !isFist && distanceNow <= (pinch.wasPinching ? PINCH_OFF : PINCH_ON);
    pinch.wasPinching = pinching;

    if (pinching) {
      if (!pinch.active) {
        pinch.active = true;
        pinch.since = now;
      } else if (!pinch.pressed && now - pinch.since >= PINCH_SETTLE_MS) {
        pinch.pressed = true;
        optionsRef.current.onDown(next.x, next.y);
      }
    } else {
      if (pinch.pressed) releasePinch(next.x, next.y);
      pinch.active = false;
    }
  };

  const start = (): void => {
    if (runningRef.current || state === 'starting') return;
    const token = (startTokenRef.current += 1);
    runningRef.current = true;
    setState('starting');
    setError(null);

    void (async () => {
      try {
        // Ask for the camera first: Safari only honours getUserMedia from the
        // click that started this call, before any slow model download.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
        });
        if (!runningRef.current || startTokenRef.current !== token) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;

        const video = document.createElement('video');
        video.playsInline = true;
        video.muted = true;
        video.autoplay = true;
        // iOS only decodes frames for a video that is in the document. Keep it
        // effectively invisible rather than `display: none`, which can pause it.
        video.style.cssText =
          'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0.01;pointer-events:none;';
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        document.body.appendChild(video);
        video.srcObject = stream;
        videoRef.current = video;
        await video.play();

        const { hand, face } = await createLandmarkers();
        if (!runningRef.current || startTokenRef.current !== token) {
          // The user stopped while the models were downloading; tear down the
          // camera and the half-built trackers together.
          hand.close();
          face.close();
          stop();
          return;
        }
        handRef.current = hand;
        faceRef.current = face;

        setState('running');
        setError(null);
        detachTouchRef.current();

        // Track on the frames the *camera* produces, not on every display frame.
        //
        // Reported: "in the iPad, the hand tracking isn't as good and sensitive
        // and the FPS is very low as well it doesn't respond correctly to my hand
        // movements."
        //
        // This loop used to call the hand model on every requestAnimationFrame,
        // which on an iPad fires about 60 times a second while the camera only
        // delivers 24. So roughly six of every ten inferences ran on the exact
        // same video frame - no new information, but the model still ran, on the
        // GPU and synchronously on the main thread. That starved the UI thread
        // (which is also the thread that has to draw the cursor), so the pointer
        // lagged behind the hand no matter how good the detection was.
        //
        // `requestVideoFrameCallback` fires once per *decoded camera frame*, which
        // is precisely the cadence the model wants. The display loop stays as a
        // fallback for browsers without it.
        const supportsVideoFrame = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

        if (supportsVideoFrame) {
          // One inference per decoded camera frame - the cadence the model wants.
          const onVideoFrame = (): void => {
            if (!runningRef.current) return;
            const activeVideo = videoRef.current;
            if (activeVideo) detect(activeVideo, performance.now());
            videoFrameRef.current = activeVideo?.requestVideoFrameCallback(onVideoFrame) ?? null;
          };
          videoFrameRef.current = video.requestVideoFrameCallback(onVideoFrame);
        } else {
          // Fallback: the display loop. The guard inside detect() still prevents
          // running twice on the same camera frame.
          const loop = (): void => {
            if (!runningRef.current) return;
            const activeVideo = videoRef.current;
            if (activeVideo) detect(activeVideo, performance.now());
            rafRef.current = requestAnimationFrame(loop);
          };
          rafRef.current = requestAnimationFrame(loop);
        }
      } catch (err) {
        if (startTokenRef.current !== token) return;
        // A permission failure leaves no hardware, but a model/WASM failure
        // happens after the camera is open. Release everything either way so a
        // Retry starts from a clean state and the camera light goes out.
        stop();
        const message =
          err instanceof Error
            ? err.name === 'NotAllowedError'
              ? 'Camera permission was denied. Allow the camera in Safari settings and try again.'
              : err.name === 'NotFoundError'
                ? 'No camera was found on this device.'
                : err.message
            : 'Could not start the iPad camera.';
        setState('failed');
        setError(message);
        optionsRef.current.onGaze(null);
      }
    })();
  };

  /**
   * Start tracking as soon as the tablet connects, without a button.
   *
   * Reported: "The handtracking should automatically start on iPad when I
   * connect it. No button needed."
   *
   * Safari refuses getUserMedia unless the call happens inside a user gesture, so
   * a page-load start can never work - there is no gesture to be inside of. Two
   * things are done instead:
   *
   *  1. Try to start immediately. If the site has already been granted camera
   *     permission in this browser session Safari does allow it, and the user
   *     never sees the button at all.
   *  2. If that is refused, arm a one-shot listener so the *first* touch
   *     anywhere on the tablet starts tracking. That is a real gesture, so
   *     Safari accepts it, and the user no longer has to find and aim at a small
   *     button on a screen they are about to control by hand.
   */
  useEffect(() => {
    let cancelled = false;
    const tryAutoStart = (): void => {
      if (cancelled || runningRef.current) return;
      start();
    };
    // Defer a frame so the first render (and any permission prompt from a
    // previous visit) has settled.
    const autoTimer = setTimeout(tryAutoStart, 400);

    // The listener stays armed until tracking is genuinely running.
    //
    // Detaching after one tap looked right but made a failed attempt
    // unrecoverable: if Safari refused that gesture, or the camera was busy, the
    // chip said "tap anywhere to try again" while nothing was listening any
    // more. It now survives failures and detaches only once a run has actually
    // started.
    let armed = true;
    const onFirstTouch = (): void => {
      if (!armed || cancelled) return;
      // A start already in flight also owns the gesture, so do not queue another.
      if (runningRef.current) {
        detachTouch();
        return;
      }
      start();
    };
    const detachTouch = (): void => {
      armed = false;
      window.removeEventListener('pointerdown', onFirstTouch, true);
      window.removeEventListener('touchstart', onFirstTouch, true);
    };
    // Capture phase everywhere: any tap counts, even one aimed at another
    // control, because the only thing it is being used for is permission.
    window.addEventListener('pointerdown', onFirstTouch, true);
    window.addEventListener('touchstart', onFirstTouch, true);
    detachTouchRef.current = detachTouch;

    return () => {
      cancelled = true;
      clearTimeout(autoTimer);
      detachTouch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop cleanly on unmount so the camera light never stays on.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      startTokenRef.current += 1;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
        video.parentNode?.removeChild(video);
      }
      handRef.current?.close();
      faceRef.current?.close();
    };
  }, []);

  return { state, error, looking, start, stop };
}
