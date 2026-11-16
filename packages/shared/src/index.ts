/**
 * ORBIT wire protocol.
 *
 * Every message between the desktop app, the server and the receiver
 * crosses this file. Keep it additive: both ends run the same version.
 */

export const PROTOCOL_VERSION = 1;

export * from './policy.js';

// ---------------------------------------------------------------------------
// Devices, pairing, sessions
// ---------------------------------------------------------------------------

export type DeviceRole = 'desktop' | 'receiver';

export type ReceiverKind = 'ipad' | 'tv' | 'browser';

export interface DeviceInfo {
  /** Stable id for this installation, kept in local storage. */
  id: string;
  role: DeviceRole;
  name: string;
  kind: ReceiverKind;
}

export type SessionPhase =
  | 'idle'
  /** Desktop is sharing, receiver may join with the pairing code. */
  | 'awaiting-receiver'
  /** Receiver joined and is streaming. */
  | 'live'
  /** Receiver opted out or lost its socket; desktop keeps state. */
  | 'paused'
  | 'ended';

export interface PairingOffer {
  /** Address shown to the user as a URL, e.g. http://192.168.1.20:8787 */
  url: string;
  host: string;
  port: number;
  /** Short-lived, single-use, 6 chars. */
  code: string;
  expiresAt: number;
  /** Optional QR payload: same url with the code embedded. */
  qrPayload: string;
}

export interface ReceiverRecord {
  id: string;
  name: string;
  kind: ReceiverKind;
  connectedAt: number;
  lastSeenAt: number;
  /** Coarse network origin, shown for the user's own recognition. */
  origin: string;
}

export interface SessionInfo {
  id: string;
  phase: SessionPhase;
  startedAt: number;
  expiresAt: number;
  receivers: ReceiverRecord[];
}

// ---------------------------------------------------------------------------
// Window sources
// ---------------------------------------------------------------------------

export interface WindowSource {
  id: string;
  name: string;
  appName?: string;
  /** true for ORBIT-native panels (viewer/player), false for a live window. */
  native: boolean;
  thumbnailDataUrl?: string;
}

/** Sent from desktop -> receivers when the source catalog changes. */
export interface SourceCatalog {
  sources: WindowSource[];
  /** Currently remembered broadcast target. */
  activeSourceId: string | null;
}

// ---------------------------------------------------------------------------
// Workspace panels
// ---------------------------------------------------------------------------

export type InteractionMode = 'arrange' | 'interact';

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Panel {
  id: string;
  sourceId: string;
  title: string;
  rect: PanelRect;
  z: number;
  selected: boolean;
  /** Live window stream vs ORBIT-native panel. */
  kind: 'live' | 'native';
  connected: boolean;
  minWidth: number;
  minHeight: number;
  /** 0 = free, otherwise enforce width/height ratio. */
  aspectRatio?: number;
  /**
   * Which receiver this panel currently lives on, or null for the shared view.
   * Set by a throw gesture; the desktop remains the authority.
   */
  ownerDeviceId?: string | null;
}

export interface WorkspaceState {
  mode: InteractionMode;
  panels: Panel[];
  /** Logical canvas the rects are expressed in (normalised design space). */
  canvas: { width: number; height: number };
  /**
   * A window the user is currently carrying toward this device.
   *
   * Present only while a grab is held *and* the head is turned toward the
   * tablet. The receiver shows it as a preview card so the user can see what
   * they are about to send before they open their hand - and, just as
   * importantly, sees it disappear when they look back, which is the
   * confirmation that nothing will be transferred.
   */
  preview?: { title: string } | null;
}

// ---------------------------------------------------------------------------
// WebRTC signalling
// ---------------------------------------------------------------------------

export type SdpKind = 'offer' | 'answer';

export interface SignalDescription {
  kind: SdpKind;
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * Receiver -> desktop relay envelopes. Each receiver message maps to exactly
 * one desktop-facing envelope so the desktop has a single, typed inbox.
 */
export type DesktopRelayMessage =
  | { t: 'server.panel.move'; panelId: string; rect: PanelRect }
  | { t: 'server.panel.select'; panelId: string }
  | { t: 'server.panel.close'; panelId: string }
  | { t: 'server.panel.return'; panelId: string }
  | { t: 'server.mode.set'; mode: InteractionMode }
  | { t: 'server.command'; text: string; mode: VoiceMode }
  | { t: 'server.stop' }
  | { t: 'server.answer'; req: SignalDescription; panelId: string }
  | { t: 'server.ice'; candidate: IceCandidatePayload; panelId: string }
  | { t: 'server.approval.response'; approvalId: string; accept: boolean }
  | { t: 'server.gaze.tablet'; looking: boolean | null; at: number }
  /**
   * The iPad's own hand tracker reporting whether the hand it can see is a fist.
   *
   * This exists because the laptop's camera cannot see the hand once the user
   * has turned their head to the iPad: the grab gesture is "hold a fist while
   * looking at the laptop, look at the iPad, then open the hand", and the second
   * half of it happens with the laptop's webcam pointed at the back of a head.
   * The tablet is the only camera that can see that release, so it reports it.
   */
  | { t: 'server.fist.tablet'; fist: boolean; at: number };

export interface StreamTarget {
  panelId: string;
  sourceId: string;
  width: number;
  height: number;
  fps: number;
}

/** Which physical screen the user's head is currently aimed at. */
export type ScreenTarget = 'laptop' | 'tablet';

/**
 * The gesture pointer projected into screen space.
 *
 * `x`/`y` are fractions of the *screen*, not the camera frame, so the receiver
 * can place it without knowing anything about the camera. `visible` is false
 * whenever the hand is out of view or the pointer is aimed at the laptop.
 */
export interface HandPointer {
  x: number;
  y: number;
  visible: boolean;
  target: ScreenTarget | null;
}
// ---------------------------------------------------------------------------
// Permission model (section 8 of the plan)
// ---------------------------------------------------------------------------

export type ActionCategory =
  | 'workspace'
  | 'apps'
  | 'browser'
  | 'media'
  | 'documents'
  | 'dictation'
  | 'coding'
  | 'session'
  | 'destructive'
  | 'sensitive'
  | 'shell';

export type ActionPolicy = 'allowed' | 'needs-approval' | 'blocked';

export interface PolicyDecision {
  category: ActionCategory;
  policy: ActionPolicy;
  reason: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  action: string;
  category: ActionCategory;
  detail: string;
  requestedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Task / assistant plumbing
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'cancelled';

export interface TaskStep {
  index: number;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface TaskState {
  id: string;
  utterance: string;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type VoiceMode = 'command' | 'dictation';

export interface TranscriptEvent {
  mode: VoiceMode;
  text: string;
  confidence?: number;
  provisional: boolean;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { t: 'server.welcome'; protocol: number; session: SessionInfo; pairing?: PairingOffer }
  | { t: 'server.session'; session: SessionInfo }
  | { t: 'server.pairing'; pairing: PairingOffer }
  | { t: 'server.receiver.joined'; receiver: ReceiverRecord }
  | { t: 'server.receiver.left'; receiverId: string }
  | { t: 'server.sources'; sources: SourceCatalog }
  | { t: 'server.workspace'; state: WorkspaceState }
  | { t: 'server.offer'; offer: SignalDescription; panelId: string }
  | { t: 'server.stream.stop'; panelId: string }
  | { t: 'server.pointer'; pointer: HandPointer }
  | { t: 'server.pointer.click'; pointer: HandPointer }
  | { t: 'server.pointer.down'; pointer: HandPointer }
  | { t: 'server.pointer.up'; pointer: HandPointer }
  | { t: 'server.task'; task: TaskState }
  | { t: 'server.approval.request'; approval: ApprovalRequest }
  | { t: 'server.transcript'; transcript: TranscriptEvent }
  | { t: 'server.voice.state'; state: 'idle' | 'listening' | 'transcribing' }
  | { t: 'server.error'; code: ErrorCode; message: string }
  | { t: 'server.pong'; at: number }
  | DesktopRelayMessage;

export type ClientMessage =
  // receiver -> server
  | { t: 'receiver.hello'; device: DeviceInfo; code: string }
  | { t: 'receiver.panel.move'; panelId: string; rect: PanelRect }
  | { t: 'receiver.panel.select'; panelId: string }
  | { t: 'receiver.panel.close'; panelId: string }
  | { t: 'receiver.panel.return'; panelId: string }
  | { t: 'receiver.mode.set'; mode: InteractionMode }
  | { t: 'receiver.command'; text: string; mode: VoiceMode }
  | { t: 'receiver.stop' }
  | { t: 'receiver.ping'; at: number }
  | { t: 'receiver.answer'; req: SignalDescription; panelId: string }
  | { t: 'receiver.ice'; candidate: IceCandidatePayload; panelId: string }
  | { t: 'receiver.approval'; approvalId: string; accept: boolean }
  | {
      /**
       * The iPad's own face tracker reporting whether the user is looking at
       * it. `null` means it has no opinion (no face, camera off), and the
       * laptop's own gaze router stays in charge.
       */
      t: 'receiver.gaze';
      looking: boolean | null;
      at: number;
    }
  | {
      /**
       * The iPad's own hand tracker: is the hand it can see a closed fist?
       *
       * Sent on every change, so the laptop can tell a *release* (fist -> open)
       * from a hand that simply left the frame. See `server.fist.tablet`.
       */
      t: 'receiver.fist';
      fist: boolean;
      at: number;
    }
  // desktop -> server
  | { t: 'desktop.hello'; device: DeviceInfo }
  | { t: 'desktop.session.start'; sources: SourceCatalog }
  | { t: 'desktop.session.stop' }
  | { t: 'desktop.sources'; sources: SourceCatalog }
  | { t: 'desktop.workspace'; state: WorkspaceState }
  | { t: 'desktop.offer'; offer: SignalDescription; panelId: string }
  | { t: 'desktop.ice'; candidate: IceCandidatePayload; panelId: string }
  | { t: 'desktop.stream.stop'; panelId: string }
  | { t: 'desktop.pointer'; pointer: HandPointer }
  | { t: 'desktop.pointer.click'; pointer: HandPointer }
  | { t: 'desktop.pointer.down'; pointer: HandPointer }
  | { t: 'desktop.pointer.up'; pointer: HandPointer }
  | { t: 'desktop.task'; task: TaskState }
  | { t: 'desktop.approval.request'; approval: ApprovalRequest }
  | { t: 'desktop.transcript'; transcript: TranscriptEvent }
  | { t: 'desktop.voice.state'; state: 'idle' | 'listening' | 'transcribing' }
  | { t: 'desktop.device.revoke'; receiverId: string }
  | { t: 'desktop.ping'; at: number }
  | { t: 'server.ping'; at: number }
  // server -> both
  | ServerMessage;

export type ErrorCode =
  | 'bad-code'
  | 'code-expired'
  | 'session-expired'
  | 'no-session'
  | 'unauthorised'
  | 'revoked'
  | 'protocol'
  | 'rate-limited'
  | 'not-supported'
  /** Too many wrong attempts against one pairing code; a new code is needed. */
  | 'locked';

/** Every code the server can send, so the receiver can handle all of them. */
const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'bad-code',
  'code-expired',
  'session-expired',
  'no-session',
  'unauthorised',
  'revoked',
  'protocol',
  'rate-limited',
  'not-supported',
  'locked',
]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

export function isServerMessage(m: unknown): m is ServerMessage {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { t?: unknown }).t === 'string' &&
    (m as { t: string }).t.startsWith('server.')
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers (kept dependency-free for both Node and the browser)
// ---------------------------------------------------------------------------

export const DEFAULT_CANVAS: { width: number; height: number } = { width: 1024, height: 768 };

export const PANEL_LIMITS = {
  minWidth: 160,
  minHeight: 100,
} as const;

/** Clamp a panel rect inside the logical canvas, honouring minimums. */
export function clampRect(rect: PanelRect, canvas = DEFAULT_CANVAS): PanelRect {
  const width = clamp(rect.width, PANEL_LIMITS.minWidth, canvas.width);
  const height = clamp(rect.height, PANEL_LIMITS.minHeight, canvas.height);
  return {
    x: clamp(rect.x, 0, canvas.width - width),
    y: clamp(rect.y, 0, canvas.height - height),
    width,
    height,
  };
}

export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/** Apply an aspect ratio to a rect while keeping the visual centre stable. */
export function applyAspect(rect: PanelRect, ratio: number | undefined): PanelRect {
  if (!ratio || ratio <= 0) return rect;
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  // Fit inside the current box, then re-expand to the longest edge.
  let w = width;
  let h = w / ratio;
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) };
}

export function topZ(panels: Panel[]): number {
  return panels.reduce((max, p) => Math.max(max, p.z), 0);
}

// ---------------------------------------------------------------------------
// Throwing a panel to another device
// ---------------------------------------------------------------------------

export type ThrowDirection = 'left' | 'right' | 'up' | 'down' | 'none';

/**
 * Choose which connected device a throw should target.
 *
 * With one device the throw is unambiguous: send it there. With several, the
 * direction picks by position in the list, so the mapping is stable and the user
 * can learn it (left = first device, right = last). We never guess when there is
 * nothing to send to: an empty result means "do nothing", which the caller shows
 * as a message rather than silently dropping the panel.
 */
export function pickThrowTarget(
  receivers: ReceiverRecord[],
  direction: ThrowDirection,
  currentReceiverId: string | null,
): ReceiverRecord | null {
  if (receivers.length === 0) return null;
  if (direction === 'none') return null;

  // A throw never targets the device the panel is already on; that would look
  // like the gesture did nothing.
  const candidates = receivers.filter((r) => r.id !== currentReceiverId);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) return candidates[0]!;

  // Horizontal throws pick by order; vertical throws are not meaningful yet, so
  // they fall back to the next device in the list rather than failing.
  if (direction === 'left') return candidates[0]!;
  if (direction === 'right') return candidates[candidates.length - 1]!;

  const index = receivers.findIndex((r) => r.id === currentReceiverId);
  const next = (index + 1) % candidates.length;
  return candidates[next]!;
}
