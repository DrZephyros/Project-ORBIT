import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type DesktopRelayMessage,
  type ErrorCode,
  type ReceiverRecord,
  type ServerMessage,
} from '@orbit/shared';
import { SessionRegistry, type ManagedSession } from './session.js';
import { lanAddress } from './net.js';
import { receiverScheme } from './config.js';

interface Client {
  socketId: string;
  socket: WebSocket;
  session: ManagedSession | null;
  role: 'desktop' | 'receiver' | 'unknown';
  receiverId?: string;
  alive: boolean;
  origin: string;
}

const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * How long a receiver's identity survives a dropped socket.
 *
 * Long enough for an iPad that lost Wi-Fi to reconnect and resume by device id
 * (it has no pairing code any more), short enough that a genuinely closed tab
 * disappears from the desktop quickly.
 */
const RECEIVER_RESUME_GRACE_MS = 30_000;

export class OrbitHub {
  private wss: WebSocketServer[] = [];
  private clients = new Map<string, Client>();
  private registry = new SessionRegistry();
  private seq = 0;
  private sweeper: NodeJS.Timeout;

  constructor(
    servers: Server | Server[],
    private port: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);

    // One hub can front several listeners (TLS on 8787, plain loopback on 8788)
    // while sharing a single session registry. Separate hubs would each get
    // their own registry, so a desktop on one could never see a receiver on the
    // other.
    for (const server of Array.isArray(servers) ? servers : [servers]) {
      this.attach(server);
    }
  }

  /** Attach another HTTP(S) listener to this hub, sharing clients and sessions. */
  attach(server: Server): void {
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: MAX_MESSAGE_BYTES,
      // Local network only: reject browser origins that are not our own receiver.
      verifyClient: (info, done) => {
        const ok = isAllowedOrigin(info.origin, this.port);
        if (!ok) return done(false, 403, 'Forbidden origin');
        return done(true);
      },
    });

    wss.on('connection', (socket, req) => this.onConnection(socket, req.socket.remoteAddress ?? ''));
    wss.on('close', () => clearInterval(this.sweeper));
    this.wss.push(wss);
  }

  private onConnection(socket: WebSocket, remote: string): void {
    const client: Client = {
      socketId: `s${++this.seq}`,
      socket,
      session: null,
      role: 'unknown',
      alive: true,
      origin: remote.replace(/^::ffff:/, ''),
    };
    this.clients.set(client.socketId, client);

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (raw) => {
      // Never let a malformed frame take the hub down.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        this.sendError(client, 'protocol', 'Message was not valid JSON.');
        return;
      }
      if (!isClientMessage(parsed)) {
        this.sendError(client, 'protocol', 'Unknown message type.');
        return;
      }
      try {
        this.route(client, parsed);
      } catch (err) {
        this.sendError(client, 'protocol', err instanceof Error ? err.message : 'Handler failed.');
      }
    });

    socket.on('close', () => this.onClose(client));
    socket.on('error', () => {
      /* close handler performs cleanup */
    });
  }

  private route(client: Client, msg: ClientMessage): void {
    switch (msg.t) {
      case 'desktop.hello': {
        if (client.role === 'receiver') return this.sendError(client, 'unauthorised', 'Socket already bound to a receiver.');
        const session = this.registry.startDesktop(msg.device, client.socketId, lanAddress(), this.port);
        client.role = 'desktop';
        client.session = session;
        // Reuse a code that is still live. A desktop socket reconnect used to
        // rotate it immediately, invalidating the QR still on the iPad's screen
        // and turning a healthy pairing attempt into a bad-code error.
        const live = session.pairingOffer();
        const pairing =
          live && live.expiresAt > Date.now() ? session.pairing! : session.issuePairing();
        const base = `${receiverScheme()}://${lanAddress()}:${this.port}/r`;
        this.send(client, {
          t: 'server.welcome',
          protocol: PROTOCOL_VERSION,
          session: session.info(),
          pairing: {
            url: base,
            host: lanAddress(),
            port: this.port,
            code: pairing.code,
            expiresAt: pairing.expiresAt,
            qrPayload: `${base}#c=${pairing.code}`,
          },
        });
        return;
      }

      case 'receiver.hello': {
        if (client.role === 'desktop') return this.sendError(client, 'unauthorised', 'Socket already bound to the desktop.');
        const session = this.registry.current();
        if (!session || session.phase === 'ended') {
          return this.sendError(client, 'no-session', 'No ORBIT session is running on the laptop.');
        }
        const result = session.joinReceiver(msg.device, msg.code, client.socketId, client.origin);
        if (!result.ok) {
          const code: ErrorCode =
            result.reason === 'expired' ? 'code-expired' : result.reason === 'no-code' ? 'no-session' : 'bad-code';
          const text =
            result.reason === 'locked'
              ? 'Too many attempts. Ask the laptop for a new pairing code.'
              : result.reason === 'expired'
                ? 'That pairing code expired.'
                : result.reason === 'no-code'
                  ? msg.code
                    ? 'That code does not match.'
                    : 'This iPad is not paired with the current session. Get a new code on the laptop.'
                  : 'That code does not match.';
          // Re-publish the live code to the laptop. The usual cause of a
          // rejected scan is that the desktop reconnected and the server issued
          // a new code while the old QR was still on screen; showing the code
          // that actually works turns a dead end into a visible, fixable state.
          const live = session.pairingOffer();
          if (live) this.broadcastToDesktop(session, { t: 'server.pairing', pairing: live });
          return this.sendError(client, code, text);
        }

        client.role = 'receiver';
        client.session = session;
        client.receiverId = result.receiver.id;

        this.send(client, { t: 'server.welcome', protocol: PROTOCOL_VERSION, session: session.info() });
        this.broadcastToDesktop(session, { t: 'server.receiver.joined', receiver: result.receiver });

        // A fresh code is only useful to the desktop UI; the receiver already joined.
        const pairing = session.pairingOffer();
        if (pairing) this.broadcastToDesktop(session, { t: 'server.pairing', pairing });
        this.broadcastSession(session);
        return;
      }

      case 'desktop.session.start':
      case 'desktop.session.stop':
      case 'desktop.sources':
      case 'desktop.workspace':
      case 'desktop.offer':
      case 'desktop.ice':
      case 'desktop.stream.stop':
      case 'desktop.pointer':
      case 'desktop.pointer.click':
      case 'desktop.pointer.down':
      case 'desktop.pointer.up':
      case 'desktop.task':
      case 'desktop.approval.request':
      case 'desktop.transcript':
      case 'desktop.voice.state':
      case 'desktop.device.revoke':
      case 'desktop.pairing.request':
      case 'desktop.ping': {
        if (client.role !== 'desktop') return this.sendError(client, 'unauthorised', 'Desktop message from a non-desktop socket.');
        const session = client.session;
        if (!session) return this.sendError(client, 'no-session', 'Start a session first.');

        if (msg.t === 'desktop.pairing.request') {
          // Always rotate. The Setup page asks when a countdown reaches zero and
          // when the user presses "New code", and both mean "give me a different
          // code" - answering with the same one would look like a dead button.
          // The page only asks once per expiry, so there is no loop to protect
          // against by refusing here.
          session.issuePairing();
          const offer = session.pairingOffer();
          if (offer) this.send(client, { t: 'server.pairing', pairing: offer });
          return;
        }

        if (msg.t === 'desktop.device.revoke') {
          const revoked = session.revoke(msg.receiverId);
          if (revoked) {
            this.disconnectReceiver(session, revoked.id, 'revoked');
            this.broadcastToDesktop(session, { t: 'server.receiver.left', receiverId: revoked.id });
            this.broadcastSession(session);
          }
          return;
        }

        if (msg.t === 'desktop.session.stop') {
          session.end('desktop-stop');
          this.registry.dropDesktop(client.socketId);
          this.broadcastToReceivers(session, { t: 'server.error', code: 'session-expired', message: 'The desktop ended the session.' });
          this.disconnectAllReceivers(session);
          this.broadcastSession(session);
          return;
        }

        if (msg.t === 'desktop.sources') this.broadcastToReceivers(session, { t: 'server.sources', sources: msg.sources });
        else if (msg.t === 'desktop.workspace') this.broadcastToReceivers(session, { t: 'server.workspace', state: msg.state });
        else if (msg.t === 'desktop.offer') this.broadcastToReceivers(session, { t: 'server.offer', offer: msg.offer, panelId: msg.panelId });
        else if (msg.t === 'desktop.ice') this.broadcastToReceivers(session, { t: 'server.ice', candidate: msg.candidate, panelId: msg.panelId });
        else if (msg.t === 'desktop.stream.stop') this.broadcastToReceivers(session, { t: 'server.stream.stop', panelId: msg.panelId });
        else if (msg.t === 'desktop.pointer') this.broadcastToReceivers(session, { t: 'server.pointer', pointer: msg.pointer });
        else if (msg.t === 'desktop.pointer.click') this.broadcastToReceivers(session, { t: 'server.pointer.click', pointer: msg.pointer });
        else if (msg.t === 'desktop.pointer.down') this.broadcastToReceivers(session, { t: 'server.pointer.down', pointer: msg.pointer });
        else if (msg.t === 'desktop.pointer.up') this.broadcastToReceivers(session, { t: 'server.pointer.up', pointer: msg.pointer });
        else if (msg.t === 'desktop.task') this.broadcastToReceivers(session, { t: 'server.task', task: msg.task });
        else if (msg.t === 'desktop.approval.request') this.broadcastToReceivers(session, { t: 'server.approval.request', approval: msg.approval });
        else if (msg.t === 'desktop.transcript') this.broadcastToReceivers(session, { t: 'server.transcript', transcript: msg.transcript });
        else if (msg.t === 'desktop.voice.state') this.broadcastToReceivers(session, { t: 'server.voice.state', state: msg.state });
        else if (msg.t === 'desktop.ping') this.send(client, { t: 'server.pong', at: msg.at });
        else if (msg.t === 'desktop.session.start') {
          this.broadcastToReceivers(session, { t: 'server.sources', sources: msg.sources });
          // Starting a session is the moment the user needs a code to show. The
          // offer was previously only sent from desktop.hello, so after the first
          // join rotated it the laptop had nothing to display at all.
          const pairing = session.pairingOffer() ?? issueAndOffer(session);
          if (pairing) this.send(client, { t: 'server.pairing', pairing });
        }
        return;
      }

      case 'receiver.panel.move':
      case 'receiver.panel.select':
      case 'receiver.panel.close':
      case 'receiver.panel.return':
      case 'receiver.mode.set':
      case 'receiver.command':
      case 'receiver.stop':
      case 'receiver.answer':
      case 'receiver.ice':
      case 'receiver.approval':
      case 'receiver.fist':
      case 'receiver.gaze':
      case 'receiver.remote.pointer':
      case 'receiver.remote.key': {
        if (client.role !== 'receiver') return this.sendError(client, 'unauthorised', 'Receiver message from a non-receiver socket.');
        const session = client.session;
        if (!session) return this.sendError(client, 'no-session', 'Not paired.');
        if (client.receiverId) session.touch(client.receiverId);

        // Relay verbatim to the desktop; the desktop owns workspace truth.
        const relayed = relayToDesktop(msg);
        if (relayed) this.broadcastToDesktop(session, relayed);
        return;
      }

      case 'receiver.ping': {
        if (client.role !== 'receiver') return this.sendError(client, 'unauthorised', 'Receiver message from a non-receiver socket.');
        if (client.receiverId) client.session?.touch(client.receiverId);
        this.send(client, { t: 'server.pong', at: msg.at });
        return;
      }
    }
  }

  private onClose(client: Client): void {
    this.clients.delete(client.socketId);
    const session = client.session;
    if (!session) return;

    if (client.role === 'desktop') {
      // Give the desktop a short grace period to reconnect. Dropping the
      // session immediately made every receiver reconnect into a session that
      // no longer knew them; a one-second blip became a dead iPad.
      setTimeout(() => {
        const current = this.registry.current();
        if (!current || current !== session || current.desktop.socketId !== client.socketId) return;
        this.registry.dropDesktop(client.socketId);
        this.broadcastToReceivers(session, {
          t: 'server.error',
          code: 'session-expired',
          message: 'The desktop disconnected. ORBIT will reconnect automatically.',
        });
      }, 10_000).unref();
      return;
    }

    if (client.role === 'receiver') {
      // Do not delete the identity on the first dropped socket: a reconnect
      // resumes with the device id, and the code it used is already burned.
      const gone = session.markReceiverOffline(client.socketId);
      if (!gone) return;
      this.broadcastToDesktop(session, { t: 'server.receiver.left', receiverId: gone.id });
      this.broadcastSession(session);
      setTimeout(() => {
        const removed = session.removeReceiverIfOffline(gone.id);
        if (removed) this.broadcastSession(session);
      }, RECEIVER_RESUME_GRACE_MS).unref();
    }
  }

  private sweep(): void {
    const session = this.registry.current();
    if (!session) return;

    const { expired, staleReceivers } = session.sweep();
    for (const r of staleReceivers) {
      this.sendToReceiver(session, r.id, { t: 'server.error', code: 'session-expired', message: 'Idle timeout.' });
      this.closeReceiverSocket(session, r.id);
      this.broadcastToDesktop(session, { t: 'server.receiver.left', receiverId: r.id });
    }
    if (expired) {
      this.broadcastToReceivers(session, { t: 'server.error', code: 'session-expired', message: 'Session expired.' });
      this.disconnectAllReceivers(session);
      session.end('expired');
      this.broadcastSession(session);
    }

    // Liveness probe: drop sockets that stopped answering.
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  private disconnectReceiver(session: ManagedSession, receiverId: string, reason: string): void {
    this.sendToReceiver(session, receiverId, { t: 'server.error', code: reason === 'revoked' ? 'revoked' : 'session-expired', message: `Disconnected: ${reason}.` });
    this.closeReceiverSocket(session, receiverId);
  }

  private disconnectAllReceivers(session: ManagedSession): void {
    for (const r of [...session.receivers]) {
      this.closeReceiverSocket(session, r.record.id);
    }
  }

  private closeReceiverSocket(session: ManagedSession, receiverId: string): void {
    for (const client of this.clients.values()) {
      if (client.session === session && client.receiverId === receiverId) {
        try {
          client.socket.close(1000, 'closed');
        } catch {
          /* already closed */
        }
      }
    }
  }

  private broadcastSession(session: ManagedSession): void {
    const msg = { t: 'server.session', session: session.info() } as const;
    this.broadcastToAll(session, msg);
  }

  private broadcastToDesktop(session: ManagedSession, msg: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.session === session && client.role === 'desktop') this.send(client, msg);
    }
  }

  private broadcastToReceivers(session: ManagedSession, msg: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.session === session && client.role === 'receiver') this.send(client, msg);
    }
  }

  private broadcastToAll(session: ManagedSession, msg: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.session === session) this.send(client, msg);
    }
  }

  private sendToReceiver(session: ManagedSession, receiverId: string, msg: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.session === session && client.receiverId === receiverId) this.send(client, msg);
    }
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(msg));
  }

  private sendError(client: Client, code: ErrorCode, message: string): void {
    this.send(client, { t: 'server.error', code, message });
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const client of this.clients.values()) client.socket.terminate();
    for (const wss of this.wss) wss.close();
  }
}

/** Explicit allowlist: an unknown `t` is rejected rather than silently dropped. */
const KNOWN_TYPES = new Set<string>([
  'desktop.hello',
  'desktop.session.start',
  'desktop.session.stop',
  'desktop.sources',
  'desktop.workspace',
  'desktop.offer',
  'desktop.ice',
  'desktop.stream.stop',
  'desktop.pointer',
  'desktop.pointer.click',
  'desktop.pointer.down',
  'desktop.pointer.up',
  'desktop.task',
  'desktop.approval.request',
  'desktop.transcript',
  'desktop.voice.state',
  'desktop.device.revoke',
  'desktop.pairing.request',
  'desktop.ping',
  'receiver.hello',
  'receiver.panel.move',
  'receiver.panel.select',
  'receiver.panel.close',
  'receiver.panel.return',
  'receiver.mode.set',
  'receiver.command',
  'receiver.stop',
  'receiver.answer',
  'receiver.ice',
  'receiver.approval',
  'receiver.ping',
  'receiver.gaze',
  'receiver.fist',
  'receiver.remote.pointer',
  'receiver.remote.key',
]);

function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    KNOWN_TYPES.has((value as { t: string }).t)
  );
}

/**
 * Receiver -> desktop relay. Panel and media messages are passed through with
 * the receiver context stripped, so the desktop sees a single inbox.
 */
function relayToDesktop(msg: ClientMessage): DesktopRelayMessage | null {
  switch (msg.t) {
    case 'receiver.panel.move':
      return { t: 'server.panel.move', panelId: msg.panelId, rect: msg.rect };
    case 'receiver.panel.select':
      return { t: 'server.panel.select', panelId: msg.panelId };
    case 'receiver.panel.close':
      return { t: 'server.panel.close', panelId: msg.panelId };
    case 'receiver.panel.return':
      return { t: 'server.panel.return', panelId: msg.panelId };
    case 'receiver.mode.set':
      return { t: 'server.mode.set', mode: msg.mode };
    case 'receiver.command':
      return { t: 'server.command', text: msg.text, mode: msg.mode };
    case 'receiver.stop':
      return { t: 'server.stop' };
    case 'receiver.ping':
      return null;
    case 'receiver.answer':
      return { t: 'server.answer', req: msg.req, panelId: msg.panelId };
    case 'receiver.ice':
      return { t: 'server.ice', candidate: msg.candidate, panelId: msg.panelId };
    case 'receiver.approval':
      return { t: 'server.approval.response', approvalId: msg.approvalId, accept: msg.accept };
    case 'receiver.gaze':
      return {
        t: 'server.gaze.tablet',
        looking: msg.looking === true ? true : msg.looking === false ? false : null,
        at: Number.isFinite(msg.at) ? msg.at : Date.now(),
      };
    case 'receiver.fist':
      return {
        t: 'server.fist.tablet',
        fist: msg.fist === true,
        at: Number.isFinite(msg.at) ? msg.at : Date.now(),
      };
    case 'receiver.remote.pointer': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const kind = msg.kind === 'down' ? 'down' : msg.kind === 'up' ? 'up' : 'move';
      return {
        t: 'server.remote.pointer',
        panelId: String(msg.panelId ?? ''),
        // Clamped here rather than at the desktop: a tracker that reports a hand
        // slightly outside the frame must not be able to click outside the
        // window it is meant to be controlling.
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        kind,
        at: Number.isFinite(msg.at) ? msg.at : Date.now(),
      };
    }
    case 'receiver.remote.key': {
      const text = typeof msg.text === 'string' ? msg.text.slice(0, 512) : undefined;
      const key = typeof msg.key === 'string' ? msg.key : undefined;
      if (!text && !key) return null;
      return {
        t: 'server.remote.key',
        panelId: String(msg.panelId ?? ''),
        ...(text ? { text } : {}),
        ...(key ? { key: key as never } : {}),
        at: Number.isFinite(msg.at) ? msg.at : Date.now(),
      };
    }
    default:
      return null;
  }
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // Non-browser client (desktop app, tests).
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.port !== String(port)) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return Boolean(lanAddress() === host) || isPrivate(host);
  } catch {
    return false;
  }
}

function isPrivate(host: string): boolean {
  return /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** Issue a fresh pairing code and return its offer, for callers that need one now. */
function issueAndOffer(session: ManagedSession) {
  session.issuePairing();
  return session.pairingOffer();
}
