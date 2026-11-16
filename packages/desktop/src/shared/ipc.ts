import type {
  ApprovalRequest,
  DeviceInfo,
  HandPointer,
  InteractionMode,
  PairingOffer,
  SessionInfo,
  SourceCatalog,
  TaskState,
  TranscriptEvent,
  WorkspaceState,
  WindowSource,
} from '@orbit/shared';

export interface OrbitStatus {
  link: 'connecting' | 'online' | 'offline';
  desktop: DeviceInfo;
  session: SessionInfo | null;
  pairing: PairingOffer | null;
  receivers: SessionInfo['receivers'];
  lastError: { code: string; message: string; at: number } | null;
  sources: WindowSource[];
}

export interface OrbitPrefs {
  allowList: { apps: string[]; sites: string[]; folders: string[] };
  broadcastSourceId: string | null;
  voiceProvider: 'groq' | 'local' | 'none';
  retainTranscripts: boolean;
  onboardingComplete: boolean;
  gestureArmedByDefault: boolean;
  /** Drive the real Windows pointer with the hand, not just an in-app cursor. */
  systemPointer: boolean;
}

export interface DesktopChannel {
  /** Desktop -> main. */
  requestSources: (options: { thumbnails: boolean }) => Promise<WindowSource[]>;
  /** Ask the main process to authorise capture of this source id for the next getDisplayMedia call. */
  grantCapture: (sourceId: string) => Promise<{ ok: boolean; reason?: string }>;
  startSession: (catalog: SourceCatalog) => Promise<void>;
  stopSession: () => Promise<void>;
  setActiveSource: (sourceId: string | null) => Promise<void>;
  pushWorkspace: (state: WorkspaceState) => Promise<void>;
  offer: (panelId: string, sdp: string) => Promise<void>;
  ice: (panelId: string, candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) => Promise<void>;
  streamStop: (panelId: string) => Promise<void>;
  /**
   * Relay the hand pointer to the receiver(s). `phase` distinguishes a move
   * from a pinch press/hold release; the receiver draws the local cursor and
   * turns down/up into real DOM pointer events.
   */
  pushPointer: (
    pointer: HandPointer,
    phase?: 'move' | 'click' | 'down' | 'up',
  ) => Promise<void>;
  revoke: (receiverId: string) => Promise<void>;
  pushTask: (task: TaskState | null) => Promise<void>;
  pushApproval: (approval: ApprovalRequest | null) => Promise<void>;
  pushTranscript: (event: TranscriptEvent | null) => Promise<void>;
  pushVoiceState: (state: 'idle' | 'listening' | 'transcribing') => Promise<void>;
  getStatus: () => Promise<OrbitStatus>;
  getPrefs: () => Promise<OrbitPrefs>;
  setPrefs: (patch: Partial<OrbitPrefs>) => Promise<OrbitPrefs>;
  /** Opens the receiver URL in the default browser for a local test. */
  openReceiverPage: () => Promise<void>;
  /** Opens the folder holding the persistent main-process log. */
  openLogFolder: () => Promise<{ ok: boolean; path: string; file: string | null; error: string | null }>;
  /** Renders a QR code for the pairing URL locally; returns a data URL. */
  renderQr: (payload: string) => Promise<string>;

  // --- gestures -----------------------------------------------------------
  gestureStart: () => Promise<{ ok: boolean; message: string }>;
  /** Force a fresh camera/service process, e.g. after another app held the webcam. */
  gestureRestart: () => Promise<{ ok: boolean; message: string }>;
  gestureStop: () => Promise<void>;
  gestureArm: () => Promise<{ ok: boolean; message: string }>;
  gestureDisarm: () => Promise<{ ok: boolean; message: string }>;
  /** Adopt the palm pose being held now as "aiming at the middle of the screen". */
  gestureCalibrate: () => Promise<{ ok: boolean; message: string }>;
  /** Record the current head angle as looking at the laptop or the iPad. */
  gestureGazeCalibrate: (target: 'laptop' | 'tablet') => Promise<{ ok: boolean; message: string }>;
  gestureState: () => Promise<{
    state: 'stopped' | 'starting' | 'running' | 'failed';
    error: string | null;
  }>;
}

/** Main -> renderer events. */
export interface DesktopEvents {
  status: (status: OrbitStatus) => void;
  sources: (catalog: SourceCatalog) => void;
  workspace: (state: WorkspaceState) => void;
  panelSelect: (panelId: string) => void;
  panelClose: (panelId: string) => void;
  panelReturn: (panelId: string) => void;
  panelMove: (panelId: string, rect: { x: number; y: number; width: number; height: number }) => void;
  modeSet: (mode: InteractionMode) => void;
  command: (text: string, mode: 'command' | 'dictation') => void;
  stop: () => void;
  approvalResponse: (approvalId: string, accept: boolean) => void;
  pairing: (pairing: PairingOffer) => void;
  /** The receiver answered our offer. */
  answer: (panelId: string, sdp: string) => void;
  iceRemote: (panelId: string, candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) => void;
  error: (code: string, message: string) => void;
}

export const IPC = {
  getStatus: 'orbit:get-status',
  getPrefs: 'orbit:get-prefs',
  setPrefs: 'orbit:set-prefs',
  requestSources: 'orbit:request-sources',
  grantCapture: 'orbit:grant-capture',
  startSession: 'orbit:start-session',
  stopSession: 'orbit:stop-session',
  setActiveSource: 'orbit:set-active-source',
  pushWorkspace: 'orbit:push-workspace',
  offer: 'orbit:offer',
  ice: 'orbit:ice',
  streamStop: 'orbit:stream-stop',
  pushPointer: 'orbit:push-pointer',
  revoke: 'orbit:revoke',
  pushTask: 'orbit:push-task',
  pushApproval: 'orbit:push-approval',
  pushTranscript: 'orbit:push-transcript',
  pushVoiceState: 'orbit:push-voice-state',
  openReceiverPage: 'orbit:open-receiver-page',
  openLogFolder: 'orbit:open-log-folder',
  renderQr: 'orbit:render-qr',
  gestureStart: 'orbit:gesture-start',
  gestureRestart: 'orbit:gesture-restart',
  gestureStop: 'orbit:gesture-stop',
  gestureArm: 'orbit:gesture-arm',
  gestureDisarm: 'orbit:gesture-disarm',
  gestureCalibrate: 'orbit:gesture-calibrate',
  gestureGazeCalibrate: 'orbit:gesture-gaze-calibrate',
  gestureState: 'orbit:gesture-state',
} as const;

export const EV = {
  status: 'orbit:ev-status',
  sources: 'orbit:ev-sources',
  workspace: 'orbit:ev-workspace',
  panelSelect: 'orbit:ev-panel-select',
  panelClose: 'orbit:ev-panel-close',
  panelReturn: 'orbit:ev-panel-return',
  panelMove: 'orbit:ev-panel-move',
  modeSet: 'orbit:ev-mode-set',
  command: 'orbit:ev-command',
  stop: 'orbit:ev-stop',
  approvalResponse: 'orbit:ev-approval-response',
  pairing: 'orbit:ev-pairing',
  answer: 'orbit:ev-answer',
  iceRemote: 'orbit:ev-ice-remote',
  error: 'orbit:ev-error',
  gestureStatus: 'orbit:ev-gesture-status',
  gestureEvent: 'orbit:ev-gesture-event',
  gestureState: 'orbit:ev-gesture-state',
} as const;
