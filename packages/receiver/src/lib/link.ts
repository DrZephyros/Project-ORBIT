import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, DeviceInfo, ServerMessage, SessionInfo, SourceCatalog, WorkspaceState } from '@orbit/shared';
import { PROTOCOL_VERSION } from '@orbit/shared';

export type LinkState =
  | 'connecting'
  | 'unpaired'
  | 'pairing'
  | 'paired'
  | 'reconnecting'
  | 'offline';

/** The QR code carries `#c=123456`; only a full six-digit code is accepted. */
const HASH_CODE = /^#c=(\d{6})$/;

/**
 * The pairing code from the QR, read once per page load.
 *
 * Module scope, not a ref: React StrictMode invokes the component twice on
 * mount and the first invocation already cleared the fragment, so a ref-based
 * "read it once" would see an empty hash on the second pass and start without
 * a code. That is the same stuck-loading failure in a different disguise.
 */
let bootCode: string | null | undefined;

/**
 * Read and clear the pairing code from the URL fragment.
 *
 * Doing this before the first socket is opened removes the race the receiver
 * used to have: the pairing screen auto-joined while the initial WebSocket was
 * still connecting, which opened a *second* socket and left the join attached
 * to whichever one happened to open last. On a slow iPad that looked exactly
 * like a page stuck loading.
 */
function takeHashCode(): string | null {
  if (bootCode !== undefined) return bootCode;
  const match = HASH_CODE.exec(location.hash);
  bootCode = match ? match[1]! : null;
  if (match) {
    // Clear it so a reload cannot silently rejoin a session the user has left.
    history.replaceState(null, '', location.pathname + location.search);
  }
  return bootCode;
}

export interface RemoteError {
  code: string;
  message: string;
  at: number;
}

const DEVICE_KEY = 'orbit.receiver.device';
const NAME_KEY = 'orbit.receiver.name';
/**
 * Whether this browser was paired at least once.
 *
 * The device id above is the resume token after the one-time code is burned,
 * but it has to be *used* on a cold start too. Without this flag a reload threw
 * the token away (`paired` started false), showed the six-digit screen, and the
 * user had no code to type because the iPad only ever held a QR link.
 */
const PAIRED_KEY = 'orbit.receiver.paired';

function loadPaired(): boolean {
  try {
    return localStorage.getItem(PAIRED_KEY) === '1';
  } catch {
    return false;
  }
}

function storePaired(value: boolean): void {
  try {
    if (value) localStorage.setItem(PAIRED_KEY, '1');
    else localStorage.removeItem(PAIRED_KEY);
  } catch {
    /* private browsing: the in-memory ref still works for this page */
  }
}

/**
 * A socket that has not opened by now is treated as unreachable.
 *
 * iOS Safari will hold a WebSocket to a host whose certificate it does not
 * trust without firing `open` or `close`, so "wait for one of them" is not a
 * safe strategy on the device this app is built for.
 */
const OPEN_TIMEOUT_MS = 8_000;

/** A join with no reply by now is reported instead of spinning forever. */
const JOIN_TIMEOUT_MS = 10_000;

/**
 * A UUID that also works outside a secure context.
 *
 * `crypto.randomUUID` is only defined on HTTPS or localhost. A plain-HTTP LAN
 * address (the `ORBIT_NO_TLS=1` desktop-debug path) therefore threw during the
 * first render, leaving a blank page with no visible error. `getRandomValues`
 * does work there, so build the id from it rather than calling a missing method.
 */
function makeId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Receiver identity is stable across reloads so reconnects replace, not duplicate. */
export function loadDevice(kind: DeviceInfo['kind']): DeviceInfo {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    const name = localStorage.getItem(NAME_KEY) ?? defaultName(kind);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeviceInfo>;
      if (parsed.id) {
        return { id: parsed.id, role: 'receiver', name, kind };
      }
    }
    const id = makeId();
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id }));
    return { id, role: 'receiver', name, kind };
  } catch {
    // Private browsing or storage disabled: fall back to a per-session id.
    return { id: makeId(), role: 'receiver', name: defaultName(kind), kind };
  }
}

export function renameDevice(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* non-fatal */
  }
}

function defaultName(kind: DeviceInfo['kind']): string {
  if (kind === 'ipad') return 'iPad';
  if (kind === 'tv') return 'TV';
  return 'Browser';
}

export function detectKind(): DeviceInfo['kind'] {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ipad';
  if (/TV|SmartTV|AppleTV/i.test(ua)) return 'tv';
  return 'browser';
}

interface SocketHandle {
  state: LinkState;
  session: SessionInfo | null;
  sources: SourceCatalog | null;
  workspace: WorkspaceState | null;
  lastError: RemoteError | null;
  pairingRejections: number;
  join: (code: string) => Promise<void>;
  /** Close and reopen the socket immediately, bypassing the retry backoff. */
  reconnect: () => void;
  send: (msg: ClientMessage) => boolean;
  setHandlers: (h: Handlers) => void;
  kind: DeviceInfo['kind'];
  /** Stable receiver identity, used to tell which panels belong to this iPad. */
  device: DeviceInfo;
  /**
   * The code read from the QR fragment, if any.
   *
   * Exposed so the pairing screen can show the digits it is trying. Scanning a
   * QR auto-joins, but when that join cannot reach the laptop the fallback used
   * to be an empty six-cell form; the user had no idea which code the page had
   * read, and often no way to obtain it again.
   */
  bootCode: string | null;
}

export interface Handlers {
  onOffer?: (msg: Extract<ServerMessage, { t: 'server.offer' }>) => void;
  onIce?: (msg: Extract<ServerMessage, { t: 'server.ice' }>) => void;
  onStreamStop?: (panelId: string) => void;
  onTask?: (msg: Extract<ServerMessage, { t: 'server.task' }>) => void;
  onApproval?: (msg: Extract<ServerMessage, { t: 'server.approval.request' }>) => void;
  onTranscript?: (msg: Extract<ServerMessage, { t: 'server.transcript' }>) => void;
  onVoiceState?: (state: 'idle' | 'listening' | 'transcribing') => void;
  onSession?: (session: SessionInfo) => void;
  /** Hand cursor moved, or was hidden because the user looked at the laptop. */
  onPointer?: (pointer: Extract<ServerMessage, { t: 'server.pointer' }>['pointer']) => void;
  /** Pinch click at the cursor's current screen position. */
  onPointerClick?: (pointer: Extract<ServerMessage, { t: 'server.pointer.click' }>['pointer']) => void;
  /** Pinch pressed: hold the local pointer down so drags still work. */
  onPointerDown?: (pointer: Extract<ServerMessage, { t: 'server.pointer.down' }>['pointer']) => void;
  /** Pinch released: finish the drag/click at the cursor position. */
  onPointerUp?: (pointer: Extract<ServerMessage, { t: 'server.pointer.up' }>['pointer']) => void;
}

export function useOrbitLink(): SocketHandle {
  const kind = useRef(detectKind());
  const device = useRef<DeviceInfo>(loadDevice(kind.current));

  // A QR scan must join on the *first* socket, not on a second one opened by a
  // retry. Capture the code before the initial connect and let the socket's own
  // `open` handler send it.
  const booted = useRef(takeHashCode());

  const [state, setState] = useState<LinkState>(() =>
    booted.current ? 'pairing' : loadPaired() ? 'reconnecting' : 'connecting',
  );
  const [session, setSessionState] = useState<SessionInfo | null>(null);
  const [sources, setSources] = useState<SourceCatalog | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [lastError, setLastError] = useState<RemoteError | null>(null);
  const [pairingRejections, setPairingRejections] = useState(0);

  const socket = useRef<WebSocket | null>(null);
  const handlers = useRef<Handlers>({});
  const pendingCode = useRef<string | null>(booted.current);
  const paired = useRef(loadPaired());
  const attempts = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const heartbeat = useRef<number | null>(null);
  const lastPong = useRef(Date.now());
  /** The socket never opened within `OPEN_TIMEOUT_MS`; cancelled on open/close. */
  const openTimer = useRef<number | null>(null);
  /** A join was sent and nothing came back; cancelled by any reply. */
  const joinTimer = useRef<number | null>(null);
  /** Mirrors `state` for callbacks that must not be re-created on every change. */
  const stateRef = useRef<LinkState>('connecting');

  /**
   * Every state write goes through here.
   *
   * `connect()` is a stable callback (empty deps) so it cannot read `state`
   * directly, and it used to blindly write `connecting` on each retry. That
   * overwrote `pairing` mid-join and left the pairing screen showing a spinner
   * that never resolved — the "stuck on the loading page" report.
   */
  const setLinkState = useCallback((next: LinkState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /** Keep the in-memory resume flag and its persisted copy in step. */
  const setPaired = useCallback((value: boolean) => {
    paired.current = value;
    storePaired(value);
  }, []);

  const clearJoinTimer = useCallback(() => {
    if (joinTimer.current) {
      window.clearTimeout(joinTimer.current);
      joinTimer.current = null;
    }
  }, []);

  /**
   * Start the "we asked, nobody answered" clock.
   *
   * The server always replies to `receiver.hello` with either a welcome or an
   * error, so silence means something below us broke — a half-open socket, a
   * proxy, a laptop that went to sleep. Saying so is far better than an
   * infinite spinner, which is what the receiver used to show.
   */
  const armJoinTimer = useCallback(() => {
    clearJoinTimer();
    joinTimer.current = window.setTimeout(() => {
      joinTimer.current = null;
      if (stateRef.current !== 'pairing') return;
      // Drop the one-shot code: it is very likely already burned, and resending
      // it on every reconnect is what left a scanned QR spinning forever. The
      // device id can still resume, so fall back to that instead of a dead end.
      pendingCode.current = null;
      booted.current = null;
      setLastError({
        code: 'timeout',
        message:
          'The laptop did not answer the pairing code. It may already be used — check the code on the laptop and press Connect again.',
        at: Date.now(),
      });
      setLinkState(paired.current ? 'reconnecting' : 'unpaired');
    }, JOIN_TIMEOUT_MS);
  }, [clearJoinTimer, setLinkState]);

  const setHandlers = useCallback((h: Handlers) => {
    handlers.current = h;
  }, []);

  const send = useCallback((msg: ClientMessage): boolean => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const connect = useCallback(() => {
    // A socket that is already opening or open is the one to use. Opening a
    // second one here was the root of the pairing hang: the QR's join was
    // attached to one socket while the other finished opening and reset the
    // UI to "unpaired", with nothing left to send the code on.
    const current = socket.current;
    if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) {
      return;
    }

    const url = wsUrl();
    // Never downgrade an in-flight join to "connecting": the spinner on the
    // pairing screen is the only feedback the user has, and a retry firing
    // mid-join used to reset it to a state that also looked like loading.
    if (stateRef.current !== 'pairing') {
      setLinkState(paired.current ? 'reconnecting' : 'connecting');
    }

    const ws = new WebSocket(url);
    socket.current = ws;
    /** True once this socket has sent a hello carrying the pairing code. */
    let sentHello = false;
    /**
     * True once this socket has fallen back from a rejected code to resuming by
     * device id. Guards against a reject/retry loop.
     */
    let triedResume = false;

    // A socket that neither opens nor closes would strand the UI forever.
    // Safari can sit on a WebSocket to a host whose certificate it does not
    // trust without firing either event, which is exactly the iPad case.
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      if (socket.current !== ws) return;
      if (ws.readyState === WebSocket.OPEN) return;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      // An open timeout during a QR join used to leave the state on 'pairing',
      // which disables the pairing form: a page stuck loading with no way out.
      if (stateRef.current === 'pairing') {
        pendingCode.current = null;
        setLastError({
          code: 'offline',
          message: 'Cannot reach the laptop. Make sure ORBIT is running and both devices are on the same Wi-Fi.',
          at: Date.now(),
        });
      }
      setLinkState(paired.current ? 'reconnecting' : 'unpaired');
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      // A socket that is no longer the current one must not touch shared state.
      // This is what let an abandoned connection overwrite a live join.
      if (socket.current !== ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        return;
      }
      if (openTimer.current) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      attempts.current = 0;
      lastPong.current = Date.now();

      // Every (re)connect re-asserts identity. If the desktop still holds our
      // receiver id the server replaces the stale socket instead of creating a
      // second device entry, which keeps revocation meaningful.
      if (pendingCode.current) {
        // Keep the code until the server answers. Clearing it here lost the
        // join when the socket dropped (or was remounted by StrictMode)
        // between sending the hello and receiving the welcome.
        sentHello = true;
        sendOn(ws, { t: 'receiver.hello', device: device.current, code: pendingCode.current });
        armJoinTimer();
      } else if (paired.current) {
        // No code: the server recognises this device id and resumes the
        // session. See ManagedSession.joinReceiver's resume path.
        sentHello = true;
        sendOn(ws, { t: 'receiver.hello', device: device.current, code: '' });
      } else {
        setLinkState('unpaired');
      }
    };

    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      const wasCurrent = socket.current === ws;
      if (wasCurrent) socket.current = null;
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      heartbeat.current = null;
      if (openTimer.current) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      clearJoinTimer();
      // Detached by unmount: nothing may be retried or reported from here.
      if (!wasCurrent) return;
      // A dropped socket ends any join in flight. Reporting it is the whole
      // point: silently returning to "offline" left the user staring at a
      // spinner with no explanation of why nothing happened. The code is kept
      // so the retry can finish the join; only an explicit rejection clears it.
      if (stateRef.current === 'pairing' && sentHello) {
        setLastError({
          code: 'disconnected',
          message: 'Lost the connection while pairing. Make sure the laptop is still running ORBIT.',
          at: Date.now(),
        });
        // Stop resending a code the server may already have burned.
        pendingCode.current = null;
      }
      setLinkState(paired.current ? 'reconnecting' : stateRef.current === 'pairing' ? 'unpaired' : 'offline');
      scheduleRetry();
    };

    ws.onerror = () => {
      /* close follows */
    };

    function handleMessage(msg: ServerMessage): void {
      switch (msg.t) {
        case 'server.welcome': {
          clearJoinTimer();
          pendingCode.current = null;
          // The QR code is burned now. Forget it so a later session end shows a
          // blank pairing form rather than a code that can never work again.
          booted.current = null;
          if (openTimer.current) {
            window.clearTimeout(openTimer.current);
            openTimer.current = null;
          }
          if (msg.protocol !== PROTOCOL_VERSION) {
            setLastError({ code: 'protocol', message: 'App and server versions differ. Reload both.', at: Date.now() });
          }
          setPaired(true);
          setPairingRejections(0);
          setSessionState(msg.session);
          setLinkState('paired');
          setLastError(null);
          handlers.current.onSession?.(msg.session);
          startHeartbeat();
          return;
        }
        case 'server.session':
          setSessionState(msg.session);
          handlers.current.onSession?.(msg.session);
          if (msg.session.phase === 'ended') {
            setPaired(false);
            setLinkState('unpaired');
          }
          return;
        case 'server.sources':
          setSources(msg.sources);
          return;
        case 'server.workspace':
          setWorkspace(msg.state);
          return;
        case 'server.offer':
          handlers.current.onOffer?.(msg);
          return;
        case 'server.ice':
          handlers.current.onIce?.(msg);
          return;
        case 'server.stream.stop':
          handlers.current.onStreamStop?.(msg.panelId);
          return;
        case 'server.task':
          handlers.current.onTask?.(msg);
          return;
        case 'server.approval.request':
          handlers.current.onApproval?.(msg);
          return;
        case 'server.transcript':
          handlers.current.onTranscript?.(msg);
          return;
        case 'server.voice.state':
          handlers.current.onVoiceState?.(msg.state);
          return;
        case 'server.pointer':
          handlers.current.onPointer?.(msg.pointer);
          return;
        case 'server.pointer.click':
          handlers.current.onPointerClick?.(msg.pointer);
          return;
        case 'server.pointer.down':
          handlers.current.onPointerDown?.(msg.pointer);
          return;
        case 'server.pointer.up':
          handlers.current.onPointerUp?.(msg.pointer);
          return;
        case 'server.receiver.left':
          // Another receiver left; only affects the desktop list.
          return;
        case 'server.error': {
          // A code can be stale even on a device that paired before: the QR on
          // screen may belong to an earlier session, or the code may have been
          // burned by the join that just failed. The device id is the resume
          // token, so try it before surfacing a dead end. This is what makes
          // the Connect button work in the same case where Reconnect used to.
          if (
            stateRef.current === 'pairing' &&
            paired.current &&
            !triedResume &&
            (msg.code === 'bad-code' || msg.code === 'code-expired')
          ) {
            triedResume = true;
            pendingCode.current = null;
            sendOn(ws, { t: 'receiver.hello', device: device.current, code: '' });
            armJoinTimer();
            return;
          }
          clearJoinTimer();
          setLastError({ code: msg.code, message: msg.message, at: Date.now() });
          // Any error at all ends a join in flight. This used to be a fixed
          // list of codes, so an unlisted one (notably 'protocol', which the
          // hub sends for a malformed or rejected frame) left the receiver on
          // a spinner with no message and no way forward.
          if (stateRef.current === 'pairing') {
            setPairingRejections((n) => n + 1);
            pendingCode.current = null;
            setLinkState('unpaired');
          }
          // A rejected resume means the server no longer recognises this
          // device (new session, revoked, or app restarted). Fall back to the
          // pairing screen instead of retrying a hello that can never work.
          if (
            paired.current &&
            (msg.code === 'bad-code' || msg.code === 'unauthorised' || msg.code === 'no-session')
          ) {
            setPaired(false);
            pendingCode.current = null;
            setLinkState('unpaired');
          }
          if (msg.code === 'revoked' || msg.code === 'session-expired') {
            setPaired(false);
            pendingCode.current = null;
            setLinkState('unpaired');
          }
          return;
        }
        case 'server.pong':
          lastPong.current = Date.now();
          return;
        default:
          return;
      }
    }

    function startHeartbeat(): void {
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      heartbeat.current = window.setInterval(() => {
        // If the desktop side went away silently, surface it instead of
        // showing a frozen canvas.
        if (Date.now() - lastPong.current > 45_000) {
          ws.close();
          return;
        }
        try {
          ws.send(JSON.stringify({ t: 'receiver.ping', at: Date.now() } satisfies ClientMessage));
        } catch {
          /* close handler retries */
        }
      }, 15_000);
    }

    function scheduleRetry(): void {
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      attempts.current += 1;
      // 0.5s, 1s, 2s, 4s, capped at 8s with jitter so two receivers do not sync.
      const base = Math.min(8000, 500 * 2 ** (attempts.current - 1));
      const delay = base + Math.random() * 400;
      retryTimer.current = window.setTimeout(() => connect(), delay);
    }
  }, [armJoinTimer, clearJoinTimer, setLinkState, setPaired]);

  const reconnect = useCallback(() => {
    if (retryTimer.current) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    attempts.current = 0;
    // Detach before closing: `onclose` must not schedule a second retry and
    // race the socket we are about to open.
    const ws = socket.current;
    socket.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    connect();
  }, [connect]);

  const join = useCallback(
    async (code: string): Promise<void> => {
      const clean = code.replace(/\D/g, '').slice(0, 6);
      if (clean.length !== 6) {
        setLastError({ code: 'bad-code', message: 'Enter the six digit code shown on the laptop.', at: Date.now() });
        return;
      }
      pendingCode.current = clean;
      setLinkState('pairing');
      // Always start a fresh socket. Pressing Connect is the user telling us the
      // current connection is not good enough: reusing an OPEN socket looked
      // like it worked but the server had already burned that code, and reusing
      // a CONNECTING one could hang forever if Safari never finished the
      // handshake. `connect` sends `pendingCode` as soon as the new socket opens.
      reconnect();
    },
    [reconnect, setLinkState],
  );

  useEffect(() => {
    connect();
    return () => {
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (joinTimer.current) window.clearTimeout(joinTimer.current);
      // Drop the reference before closing, so the close handler cannot schedule
      // a retry or reset a state that belongs to a newer mount.
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, [connect]);

  return {
    state,
    session,
    sources,
    workspace,
    lastError,
    pairingRejections,
    join,
    reconnect,
    send,
    setHandlers,
    kind: kind.current,
    device: device.current,
    bootCode: booted.current,
  };
}

function sendOn(ws: WebSocket, msg: ClientMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* the caller's close handler will retry */
  }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
