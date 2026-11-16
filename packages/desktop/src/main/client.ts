import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  ClientMessage,
  DeviceInfo,
  PairingOffer,
  ServerMessage,
  SessionInfo,
  SourceCatalog,
  WorkspaceState,
} from '@orbit/shared';
import { PROTOCOL_VERSION } from '@orbit/shared';
import type { Settings } from './settings.js';

export interface ClientEvents {
  status: (state: 'connecting' | 'online' | 'offline') => void;
  welcome: (payload: { session: SessionInfo; pairing?: PairingOffer }) => void;
  session: (session: SessionInfo) => void;
  pairing: (pairing: PairingOffer) => void;
  sources: (sources: SourceCatalog) => void;
  workspace: (msg: Extract<ServerMessage, { t: 'server.workspace' }>) => void;
  receiverJoined: (r: Extract<ServerMessage, { t: 'server.receiver.joined' }>['receiver']) => void;
  receiverLeft: (receiverId: string) => void;
  command: (text: string, mode: 'command' | 'dictation') => void;
  stop: () => void;
  error: (code: string, message: string) => void;
  panelMove: (panelId: string, rect: { x: number; y: number; width: number; height: number }) => void;
  panelSelect: (panelId: string) => void;
  panelClose: (panelId: string) => void;
  panelReturn: (panelId: string) => void;
  modeSet: (mode: 'arrange' | 'interact') => void;
  approval: (approvalId: string, accept: boolean) => void;
  /** The iPad's on-device face tracker says whether the user is looking at it. */
  tabletGaze: (looking: boolean | null, at: number) => void;
  /**
   * The iPad's on-device hand tracker: is the hand in front of it a fist?
   *
   * Needed for the window carry, because by the time the user is looking at the
   * iPad their head is turned away from the laptop's webcam and the laptop can
   * no longer see whether the hand has opened.
   */
  tabletFist: (fist: boolean, at: number) => void;
}

/**
 * Desktop side of the ORBIT session.
 *
 * Owns exactly one WebSocket to the local signalling server and reconnects with
 * backoff. All outbound messages funnel through `send` so the protocol stays
 * in one place.
 */
export class OrbitClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private settings: Settings;
  private url: string;
  private attempts = 0;
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPong = Date.now();
  private closed = false;
  private catalog: SourceCatalog = { sources: [], activeSourceId: null };
  session: SessionInfo | null = null;
  pairing: PairingOffer | null = null;

  constructor(
    settings: Settings,
    // The server serves plain ws:// on its loopback port for this app, because
    // trusting a self-signed certificate inside Electron is not worth the
    // complexity. 8787 is HTTPS for the iPad and cannot accept a ws:// client.
    url = process.env.ORBIT_SERVER ?? 'ws://127.0.0.1:8788/ws',
  ) {
    super();
    this.settings = settings;
    this.url = url;
    this.connect();
  }

  get device(): DeviceInfo {
    return {
      id: this.settings.deviceId,
      role: 'desktop',
      name: process.env.COMPUTERNAME ?? 'Windows laptop',
      kind: 'browser',
    };
  }

  setCatalog(catalog: SourceCatalog): void {
    this.catalog = catalog;
    this.send({ t: 'desktop.sources', sources: catalog });
  }

  startSession(sources: SourceCatalog): void {
    this.catalog = sources;
    this.send({ t: 'desktop.session.start', sources });
  }

  stopSession(): void {
    this.send({ t: 'desktop.session.stop' });
  }

  /**
   * Ask the server to rotate the pairing code and send a fresh one back.
   *
   * Answers through the normal `pairing` event, so every place that already
   * listens for `server.pairing` (the status push to the renderer) updates without
   * knowing this method exists.
   */
  requestPairing(): boolean {
    return this.send({ t: 'desktop.pairing.request' });
  }

  revoke(receiverId: string): void {
    this.settings.forgetReceiver(receiverId);
    this.send({ t: 'desktop.device.revoke', receiverId });
  }

  pushWorkspace(state: WorkspaceState): void {
    this.send({ t: 'desktop.workspace', state });
  }

  offer(offer: { kind: 'offer'; sdp: string }, panelId: string): boolean {
    return this.send({ t: 'desktop.offer', offer, panelId });
  }

  ice(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }, panelId: string): boolean {
    return this.send({ t: 'desktop.ice', candidate, panelId });
  }

  streamStop(panelId: string): void {
    this.send({ t: 'desktop.stream.stop', panelId });
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.emit('status', 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastPong = Date.now();
      this.emit('status', 'online');
      this.send({ t: 'desktop.hello', device: this.device });
      if (this.catalog.sources.length > 0) this.setCatalog(this.catalog);
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.emit('status', 'offline');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* close handler retries */
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'server.welcome':
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.emit('error', 'protocol', 'Server version differs from the app. Restart both.');
        }
        this.session = msg.session;
        this.pairing = msg.pairing ?? null;
        if (msg.session.receivers.length === 0 && msg.session.phase === 'idle') {
          // A session object exists but is not broadcasting yet; the desktop
          // still receives the pairing offer so setup can show a code.
        }
        for (const r of msg.session.receivers) this.settings.rememberReceiver(r.id);
        this.emit('welcome', { session: msg.session, pairing: msg.pairing });
        return;
      case 'server.session':
        this.session = msg.session;
        for (const r of msg.session.receivers) this.settings.rememberReceiver(r.id);
        this.emit('session', msg.session);
        return;
      case 'server.pairing':
        this.pairing = msg.pairing;
        this.emit('pairing', msg.pairing);
        return;
      case 'server.sources':
        this.emit('sources', msg.sources);
        return;
      case 'server.workspace':
        this.emit('workspace', msg);
        return;
      case 'server.receiver.joined':
        this.settings.rememberReceiver(msg.receiver.id);
        this.emit('receiverJoined', msg.receiver);
        return;
      case 'server.receiver.left':
        this.emit('receiverLeft', msg.receiverId);
        return;
      case 'server.panel.move':
        this.emit('panelMove', msg.panelId, msg.rect);
        return;
      case 'server.panel.select':
        this.emit('panelSelect', msg.panelId);
        return;
      case 'server.panel.close':
        this.emit('panelClose', msg.panelId);
        return;
      case 'server.panel.return':
        this.emit('panelReturn', msg.panelId);
        return;
      case 'server.mode.set':
        this.emit('modeSet', msg.mode);
        return;
      case 'server.command':
        this.emit('command', msg.text, msg.mode);
        return;
      case 'server.stop':
        this.emit('stop');
        return;
      case 'server.approval.response':
        this.emit('approval', msg.approvalId, msg.accept);
        return;
      case 'server.gaze.tablet':
        this.emit('tabletGaze', msg.looking, msg.at);
        return;
      case 'server.fist.tablet':
        this.emit('tabletFist', msg.fist, msg.at);
        return;
      case 'server.remote.pointer':
        this.emit('remotePointer', msg.panelId, msg.x, msg.y, msg.kind);
        return;
      case 'server.remote.key':
        this.emit('remoteKey', msg.panelId, msg.text, msg.key);
        return;
      case 'server.error':
        this.emit('error', msg.code, msg.message);
        return;
      case 'server.pong':
        this.lastPong = Date.now();
        return;
      case 'server.answer':
        if (msg.req) this.emit('signal', msg);
        return;
      case 'server.ice':
        this.emit('signal', msg);
        return;
      case 'server.task':
      case 'server.transcript':
      case 'server.voice.state':
      case 'server.approval.request':
        this.emit('forward', msg);
        return;
      default:
        return;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 40_000) {
        this.ws?.close();
        return;
      }
      this.send({ t: 'desktop.ping', at: Date.now() });
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.retry) clearTimeout(this.retry);
    this.attempts += 1;
    const delay = Math.min(8000, 400 * 2 ** (this.attempts - 1)) + Math.random() * 300;
    this.retry = setTimeout(() => this.connect(), delay);
  }

  dispose(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }
}
