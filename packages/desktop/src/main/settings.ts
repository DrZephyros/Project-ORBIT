import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Small local settings store.
 *
 * API keys never live here — those go to Windows-protected storage via
 * Electron's safeStorage (see secrets.ts). This file is for preferences and
 * non-sensitive state only, and it is written atomically.
 */

export interface Preferences {
  allowList: { apps: string[]; sites: string[]; folders: string[] };
  broadcastSourceId: string | null;
  voiceProvider: 'groq' | 'local' | 'none';
  /** Keep transcripts on disk after a task. Default false per section 6. */
  retainTranscripts: boolean;
  /** Caption/voice guidance shown before first session. */
  onboardingComplete: boolean;
  /**
   * Arm gesture control as soon as the camera comes up, instead of waiting for
   * an explicit arm. Default true: gesture detection is useful on its own and
   * nothing sends a gesture anywhere until a session exists.
   */
  gestureArmedByDefault: boolean;
  /**
   * Drive the real Windows pointer with the hand instead of drawing an in-app
   * cursor. Default true: a cursor that cannot leave ORBIT's window cannot
   * operate the app it is meant to control.
   */
  systemPointer: boolean;
}

const DEFAULTS: Preferences = {
  allowList: { apps: [], sites: [], folders: [] },
  broadcastSourceId: null,
  voiceProvider: 'none',
  retainTranscripts: false,
  onboardingComplete: false,
  gestureArmedByDefault: true,
  systemPointer: true,
};

/**
 * Bumped when a stored preference needs to be reinterpreted.
 *
 * v2 introduced the explicit hand-control arm toggle. Before it, nothing in the
 * UI could set `gestureArmedByDefault`, so a stored `false` was an old build's
 * default rather than a user choice. Leaving it in place meant the pointer moved
 * (that stream is deliberately independent) while every pinch-click and fist-grab
 * was discarded by the unarmed state machine — reported by users as "movement
 * works but clicking does nothing".
 */
const SETTINGS_VERSION = 2;

interface Store {
  version: number;
  prefs: Preferences;
  deviceId: string;
  receivers: string[];
}

export class Settings {
  private file: string;
  private data: Store;

  constructor(userDataDir: string) {
    const dir = join(userDataDir, 'orbit');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'settings.json');

    let parsed: Partial<Store> = {};
    if (existsSync(this.file)) {
      try {
        parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Store>;
      } catch {
        // Corrupt settings must not block startup; fall back to defaults.
        parsed = {};
      }
    }

    const prefs: Preferences = { ...DEFAULTS, ...(parsed.prefs ?? {}) };
    const version = typeof parsed.version === 'number' ? parsed.version : 1;
    if (version < 2) {
      // No UI existed to turn this off before v2, so adopt the new default once.
      prefs.gestureArmedByDefault = true;
    }

    this.data = {
      version: SETTINGS_VERSION,
      deviceId: parsed.deviceId ?? randomUUID(),
      prefs,
      receivers: Array.isArray(parsed.receivers) ? parsed.receivers : [],
    };
    this.save();
  }

  get deviceId(): string {
    return this.data.deviceId;
  }

  get prefs(): Preferences {
    return this.data.prefs;
  }

  update(patch: Partial<Preferences>): Preferences {
    this.data.prefs = { ...this.data.prefs, ...patch };
    this.save();
    return this.data.prefs;
  }

  family(): string[] {
    return [...this.data.receivers];
  }

  rememberReceiver(id: string): void {
    if (!this.data.receivers.includes(id)) {
      this.data.receivers.push(id);
      this.save();
    }
  }

  forgetReceiver(id: string): void {
    this.data.receivers = this.data.receivers.filter((r) => r !== id);
    this.save();
  }

  private save(): void {
    try {
      // Write-then-rename keeps the file valid if the process dies mid-write.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      writeFileSync(this.file, readFileSync(tmp), { mode: 0o600 });
    } catch {
      /* preferences are best-effort */
    }
  }
}
