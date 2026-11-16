import type { OrbitPrefs, OrbitStatus } from '../shared/ipc.js';

export type { OrbitPrefs, OrbitStatus };

/** Typed access to the preload bridge (declared in global.d.ts). */
export const api = () => window.orbit.invoke;

/**
 * True when the preload bridge loaded. In a plain browser or if the preload
 * script fails, `window.orbit` is missing; the UI shows an explanation instead
 * of throwing and rendering a blank window.
 */
export const bridgeAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.orbit?.invoke === 'object';

export function on<K extends keyof EventMap>(channel: K, listener: EventMap[K]): () => void {
  if (!bridgeAvailable()) return () => undefined;
  // Every renderer event goes through here, so this is the one place a bad
  // frame can be contained.
  //
  // Reported: "when I disable control of mouse pointer with hand to recenter
  // cursor and then enable it back, and then pinch, the app just crashes.
  // Everything just freezes and I have to close and reopen it."
  //
  // Pointer and pinch events arrive ~30 times a second from a separate Python
  // process, and an uncaught throw inside one of their handlers unmounts the
  // whole React tree - leaving a live window that paints nothing. A dropped
  // frame is harmless: the next one lands 33 ms later with the current truth.
  const guarded = (...args: unknown[]): void => {
    try {
      (listener as (...a: unknown[]) => void)(...args);
    } catch (error) {
      console.error(`[orbit] dropped a bad ${String(channel)} event:`, error);
    }
  };
  return window.orbit.subscribe(channel, guarded);
}

interface EventMap {
  'orbit:ev-status': (status: OrbitStatus) => void;
  'orbit:ev-pairing': (pairing: unknown) => void;
  'orbit:ev-workspace': (state: unknown) => void;
  'orbit:ev-panel-select': (panelId: string) => void;
  'orbit:ev-panel-close': (panelId: string) => void;
  'orbit:ev-panel-return': (panelId: string) => void;
  'orbit:ev-panel-move': (panelId: string, rect: unknown) => void;
  'orbit:ev-mode-set': (mode: string) => void;
  'orbit:ev-command': (text: string, mode: string) => void;
  'orbit:ev-stop': () => void;
  'orbit:ev-approval-response': (approvalId: string, accept: boolean) => void;
  'orbit:ev-answer': (panelId: string, sdp: string) => void;
  'orbit:ev-ice-remote': (panelId: string, candidate: unknown) => void;
  'orbit:ev-error': (code: string, message: string) => void;
  'orbit:ev-gesture-status': (status: GestureStatus) => void;
  'orbit:ev-gesture-event': (event: GestureEventMessage) => void;
  'orbit:ev-grab-target': (target: { hwnd: string; sourceId: string | null; title: string }) => void;
  'orbit:ev-cycle-panel': (direction: 'left' | 'right') => void;
  'orbit:ev-gesture-state': (state: { state: GestureServiceState; error: string | null }) => void;
}

export type GestureServiceState = 'stopped' | 'starting' | 'running' | 'failed';

export type GesturePhase = 'inactive' | 'armed' | 'approaching' | 'listening' | 'cooldown';

export interface GestureStatus {
  phase: GesturePhase;
  armed: boolean;
  atMouth: boolean;
  inFront: boolean;
  curled: boolean;
  curl: number;
  /** Per-finger curl (index, middle, ring, pinky) from the 2D image landmarks. */
  fingerCurls: number[];
  /** The same fingers measured in MediaPipe's metric 3D world landmarks. */
  fingerCurls3d: number[];
  pinch: boolean;
  /** True while thumb + index + middle are pinched: the wheel gesture. */
  scrolling: boolean;
  pinchDistance: number | null;
  pointer: [number, number] | null;
  /** Why the pointer is where it is: "point", "pinch", … */
  pointerReason: string;
  /** The palm aim ray in metres, for drawing it in the preview. */
  ray: GestureRay | null;
  /** Palm centre in normalised camera coordinates — what the cursor follows. */
  palm: [number, number] | null;
  distance: number | null;
  reason: string;
  handVisible: boolean;
  /** Any hand was detected, including the left one that must not drive the pointer. */
  handDetected: boolean;
  /** True only when the tracked hand is the right one. */
  rightHand: boolean;
  /** Mean brightness of the camera frame the landmarkers just saw (0-255). */
  cameraMean: number;
  /** True when the camera stream is black — not the same as an empty room. */
  cameraDark: boolean;
  faceVisible: boolean;
  /** Which hand the pointer is following, as MediaPipe labels it. */
  handLabel: string;
  /** True once a neutral palm pose has been captured, so the aim is offset-free. */
  calibrated: boolean;
  /** Which screen the head is turned to, and where a release would send a window. */
  gaze: GazeReading | null;
  /**
   * The iPad's own face tracker, relayed by the main process.
   *
   * This is the only reading that survives the head turn: as soon as the user
   * looks at the iPad the laptop's camera loses their face and `gaze` above goes
   * quiet. Optional so a status frame from an older main process still parses.
   */
  tabletGaze?: { looking: boolean | null; at: number } | null;
  confidence: number;
  landmarks: {
    /** The hand driving the cursor (the right hand). */
    hand: number[][];
    face: number[][];
    /**
     * Every hand the tracker found, labelled, so the preview can draw both.
     *
     * Optional because an older service build does not send it; the preview then
     * falls back to the single `hand` above rather than drawing nothing.
     */
    hands?: { label: string; points: number[][] }[];
  };
  resolution: [number, number];
  frames: number;
  fps: number;
  error: string | null;
}

export type GazeTarget = 'laptop' | 'tablet';

export interface GazeReading {
  target: GazeTarget | null;
  releaseTarget: GazeTarget | null;
  /**
   * How the split is being decided: `calibrated` uses the two recorded head
   * angles, `default` uses the camera-relative split (facing the laptop vs.
   * turned away) before any calibration, `invalid` means the saved anchors
   * cannot separate the screens.
   */
  mode: 'calibrated' | 'default' | 'invalid';
  yaw: number | null;
  pitch: number | null;
  calibrated: boolean;
  laptopYaw: number | null;
  tabletYaw: number | null;
  samples: number;
}

export interface GestureRay {
  /** Outward palm normal (unit vector, camera frame). */
  normal: [number, number, number];
  /** Where the ray crosses the virtual screen, in screen fraction [0, 1]. */
  hit: [number, number];
}

export interface GestureEventMessage {
  kind: string;
  phase: GesturePhase;
  message: string;
  at: number;
  detail: Record<string, unknown>;
}
