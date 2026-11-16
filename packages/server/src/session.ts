import { randomBytes } from 'node:crypto';
import type { DeviceInfo, ReceiverRecord, SessionInfo, SessionPhase } from '@orbit/shared';
import { CODE_LENGTH, checkCode, generateCode, type PairingCode } from './pairing.js';
import { receiverScheme } from './config.js';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const RECEIVER_IDLE_MS = 90 * 1000;

export interface ReceiverSlot {
  record: ReceiverRecord;
  socketId: string;
}

export interface DesktopSlot {
  device: DeviceInfo;
  socketId: string;
}

/**
 * One desktop owns one live session. Receivers attach with a pairing code.
 * The registry holds no content — only identity, phase and liveness — so a
 * crash here never leaves video or documents on disk.
 */
export class SessionRegistry {
  private session: ManagedSession | null = null;

  startDesktop(device: DeviceInfo, socketId: string, host: string, port: number): ManagedSession {
    // A desktop socket can drop and reopen without the app restarting. Keep the
    // existing session and its paired receivers in that case; replacing it used
    // to orphan every iPad mid-session for a one-second network blip.
    const existing = this.session;
    if (existing && existing.phase !== 'ended' && existing.desktop.device.id === device.id) {
      existing.attachDesktop(device, socketId, host, port);
      return existing;
    }
    if (existing) existing.end('replaced');
    this.session = new ManagedSession(device, socketId, host, port);
    return this.session;
  }

  current(): ManagedSession | null {
    return this.session;
  }

  bySocket(socketId: string): ManagedSession | null {
    const s = this.session;
    if (!s) return null;
    if (s.desktop.socketId === socketId) return s;
    return s.receivers.some((r) => r.socketId === socketId) ? s : null;
  }

  dropDesktop(socketId: string): ManagedSession | null {
    const s = this.session;
    if (!s || s.desktop.socketId !== socketId) return null;
    s.end('desktop-disconnected');
    this.session = null;
    return s;
  }
}

export interface ManagedReceiver extends ReceiverSlot {
  joinCodeUsed: string;
}

export class ManagedSession {
  readonly id = randomId();
  startedAt = Date.now();
  expiresAt = Date.now() + SESSION_TTL_MS;
  phase: SessionPhase = 'idle';
  receivers: ManagedReceiver[] = [];
  pairing: PairingCode | null = null;
  /** Desktop identity is trusted; receivers are not until paired. */
  readonly desktop: DesktopSlot;

  constructor(
    device: DeviceInfo,
    socketId: string,
    private host: string,
    private port: number,
  ) {
    this.desktop = { device, socketId };
  }

  /** Point this session at the desktop's new socket without dropping receivers. */
  attachDesktop(device: DeviceInfo, socketId: string, host: string, port: number): void {
    this.desktop.device = device;
    this.desktop.socketId = socketId;
    this.host = host;
    this.port = port;
  }

  issuePairing(): PairingCode {
    this.pairing = generateCode(PAIRING_TTL_MS);
    return this.pairing;
  }

  /** Rotate the code; also used after any successful join. */
  rotatePairing(): PairingCode {
    return this.issuePairing();
  }

  pairingOffer() {
    const code = this.pairing;
    if (!code) return undefined;
    const url = `${receiverScheme()}://${this.host}:${this.port}/r`;
    return {
      url,
      host: this.host,
      port: this.port,
      code: code.code,
      expiresAt: code.expiresAt,
      qrPayload: `${url}#c=${code.code}`,
    };
  }

  /**
   * Validate an incoming join. On success the code is burned and a new one is
   * issued so a bystander who saw the old code cannot reuse it.
   */
  joinReceiver(
    device: DeviceInfo,
    code: string,
    socketId: string,
    origin: string,
  ): { ok: true; receiver: ReceiverRecord; nextPairing: PairingCode | null } | { ok: false; reason: 'expired' | 'mismatch' | 'locked' | 'no-code' } {
    // Reconnect path. A paired receiver that loses Wi-Fi has no pairing code
    // to offer any more — the code is single-use and rotated on join. Its
    // device id is the bearer token instead (a random UUID kept in local
    // storage). Without this, a brief drop left the iPad retrying a hello that
    // could only ever be rejected, which read as a receiver stuck loading.
    if (!code) {
      const resumed = this.receivers.find((r) => r.record.id === device.id);
      if (resumed) {
        resumed.socketId = socketId;
        resumed.record.lastSeenAt = Date.now();
        resumed.record.origin = origin;
        resumed.record.name = device.name || resumed.record.name;
        resumed.record.kind = device.kind;
        this.phase = 'live';
        return { ok: true, receiver: resumed.record, nextPairing: null };
      }
      return { ok: false, reason: 'no-code' };
    }

    const pairing = this.pairing;
    if (!pairing) return { ok: false, reason: 'no-code' };

    const result = checkCode(pairing, code);
    if (!result.ok) return { ok: false, reason: result.reason };

    const record: ReceiverRecord = {
      id: device.id || randomId(),
      name: device.name || `${device.kind === 'ipad' ? 'iPad' : 'Receiver'}`,
      kind: device.kind,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      origin,
    };

    // Reconnect case: same device id replaces its old socket instead of duplicating.
    const existing = this.receivers.findIndex((r) => r.record.id === record.id);
    if (existing >= 0) this.receivers.splice(existing, 1);
    this.receivers.push({ record, socketId, joinCodeUsed: code });

    this.phase = 'live';
    const nextPairing = this.rotatePairing();
    return { ok: true, receiver: record, nextPairing };
  }

  touch(receiverId: string): void {
    const r = this.receivers.find((x) => x.record.id === receiverId);
    if (r) r.record.lastSeenAt = Date.now();
  }

  removeReceiver(socketId: string): ReceiverRecord | null {
    const idx = this.receivers.findIndex((r) => r.socketId === socketId);
    if (idx < 0) return null;
    const [gone] = this.receivers.splice(idx, 1);
    if (this.liveReceivers().length === 0 && this.phase === 'live') this.phase = 'awaiting-receiver';
    return gone ? gone.record : null;
  }

  /**
   * Mark a receiver's socket as gone but keep its identity.
   *
   * A dropped Wi-Fi link and a closed tab look identical at the socket layer.
   * Keeping the record (with no socket) for a short grace period is what lets
   * the first case resume with its device id instead of needing a brand new
   * pairing code, which the iPad no longer has.
   */
  markReceiverOffline(socketId: string): ReceiverRecord | null {
    const r = this.receivers.find((x) => x.socketId === socketId);
    if (!r) return null;
    r.socketId = '';
    r.record.lastSeenAt = Date.now();
    if (this.liveReceivers().length === 0 && this.phase === 'live') this.phase = 'awaiting-receiver';
    return r.record;
  }

  /** Remove an offline receiver, unless it reconnected while the timer ran. */
  removeReceiverIfOffline(receiverId: string): ReceiverRecord | null {
    const idx = this.receivers.findIndex((r) => r.record.id === receiverId && r.socketId === '');
    if (idx < 0) return null;
    const [gone] = this.receivers.splice(idx, 1);
    return gone ? gone.record : null;
  }

  /** Receivers with a socket attached — what the desktop should act on. */
  liveReceivers(): ReceiverSlot[] {
    return this.receivers.filter((r) => r.socketId !== '');
  }

  revoke(receiverId: string): ReceiverRecord | null {
    const idx = this.receivers.findIndex((r) => r.record.id === receiverId);
    if (idx < 0) return null;
    const [gone] = this.receivers.splice(idx, 1);
    return gone ? gone.record : null;
  }

  sweep(now = Date.now()): { expired: boolean; staleReceivers: ReceiverRecord[] } {
    const stale: ReceiverRecord[] = [];
    for (let i = this.receivers.length - 1; i >= 0; i -= 1) {
      const r = this.receivers[i]!;
      if (now - r.record.lastSeenAt > RECEIVER_IDLE_MS) {
        stale.push(r.record);
        this.receivers.splice(i, 1);
      }
    }
    return { expired: now > this.expiresAt, staleReceivers: stale };
  }

  end(reason: string): void {
    this.phase = 'ended';
    this.pairing = null;
    this.lastEndReason = reason;
  }

  lastEndReason = '';

  info(): SessionInfo {
    return {
      id: this.id,
      phase: this.phase,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      // Only receivers that still have a socket. Kept offline records exist
      // for reconnect resume, not to make the desktop think an iPad is live.
      receivers: this.liveReceivers().map((r) => r.record),
    };
  }
}

function randomId(): string {
  return randomBytes(9).toString('base64url');
}
