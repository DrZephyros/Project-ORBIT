import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persistent, rotating log for the desktop main process.
 *
 * Reported: *"Sometimes it just freezes and there is no logging so we can't tell
 * where the bug is."* Every diagnostic in the app used `console`, which only
 * exists in the terminal that `start.cmd` opened. If the app is launched from a
 * shortcut, the window is behind the app, or the freeze happens an hour in, the
 * evidence is gone.
 *
 * The log is deliberately written with `appendFileSync` rather than a
 * `WriteStream`: a stream buffers, and the process that is about to freeze or
 * crash is exactly the process that never flushes. A line is well under a
 * kilobyte, so the syscall cost is negligible next to the camera work, and every
 * line is on disk the moment it is logged.
 *
 * Logging must never be the reason something fails, so every write is guarded
 * and a broken log simply disables itself for the rest of the run.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 4 * 1024 * 1024;
/** How many rotated files to keep (`orbit.log.1`, `orbit.log.2`). */
const KEEP = 2;
/** One "still alive" line a minute, so a hard hang has a timestamp to bound it. */
const HEARTBEAT_MS = 60_000;

let dir: string | null = null;
let file: string | null = null;
let bytes = 0;
let enabled = true;
let startedAt = Date.now();

/** The directory the log lives in. Empty until `initLogging` has run. */
export function logDirectory(): string {
  if (dir) return dir;
  try {
    dir = join(app.getPath('userData'), 'orbit', 'logs');
  } catch {
    dir = '';
  }
  return dir;
}

/** The current log file, or null when logging could not be enabled. */
export function logFile(): string | null {
  return file;
}

function rotateIfNeeded(): void {
  if (!file) return;
  try {
    if (!existsSync(file)) {
      bytes = 0;
      return;
    }
    bytes = statSync(file).size;
    if (bytes < MAX_BYTES) return;
    // Drop the oldest rotated file, shift the rest up, then start a fresh one.
    for (let i = KEEP; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      if (!existsSync(from)) continue;
      if (existsSync(to)) {
        try {
          // `renameSync` cannot overwrite on Windows, so remove the target.
          unlinkSync(to);
        } catch {
          /* best effort */
        }
      }
      renameSync(from, to);
    }
    bytes = 0;
  } catch {
    /* rotation is best effort; keep appending */
  }
}

/**
 * Open the log file and write the environment header.
 *
 * Safe to call before `app.whenReady()`: `getPath('userData')` is available as
 * soon as Electron has parsed its command line, which is before any window is
 * created and therefore before any of the failures we care about.
 */
export function initLogging(): string {
  startedAt = Date.now();
  if (!enabled) return logDirectory();
  const folder = logDirectory();
  if (!folder) {
    enabled = false;
    return '';
  }
  file = join(folder, 'orbit.log');
  try {
    mkdirSync(folder, { recursive: true });
    rotateIfNeeded();
    if (existsSync(file)) bytes = statSync(file).size;
  } catch {
    enabled = false;
    file = null;
    return folder;
  }
  write('info', 'app', 'ORBIT desktop starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    log: file,
  });
  return folder;
}

function serialise(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${formatError(extra)}`;
  try {
    const text = typeof extra === 'string' ? extra : JSON.stringify(extra);
    // A stray landmark array must never turn one log line into megabytes.
    return text ? ` ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}` : '';
  } catch {
    return ' [unserialisable]';
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  return String(error);
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope}: ${message}${serialise(extra)}\n`;

  // Mirror to the terminal as well. `console.error` for warnings so they survive
  // the launcher's normal output filtering, which is what a developer looks at
  // first while the file is being written.
  try {
    if (level === 'error' || level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  } catch {
    /* no console: the file still has it */
  }

  if (!enabled || !file) return;
  try {
    rotateIfNeeded();
    appendFileSync(file, line, 'utf8');
    bytes += Buffer.byteLength(line);
  } catch {
    // A full or locked disk must not take the app down; stop trying.
    enabled = false;
  }
}

export const log = {
  debug: (scope: string, message: string, extra?: unknown): void => write('debug', scope, message, extra),
  info: (scope: string, message: string, extra?: unknown): void => write('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown): void => write('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown): void => write('error', scope, message, extra),
};

/**
 * Start the freeze detector.
 *
 * A Node timer only runs when the event loop is free. Recording how late it
 * fires turns an invisible freeze into a timestamped line with its duration, so
 * a report of "it froze" can be matched against what was running at that moment.
 * The interval is intentionally short (500 ms) so short stalls are caught too.
 */
export function startFreezeWatchdog(intervalMs = 500, thresholdMs = 750): NodeJS.Timeout {
  let expected = performance.now() + intervalMs;
  let lastBeat = Date.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    if (late >= thresholdMs) {
      write('warn', 'freeze', `main process event loop was blocked for ${Math.round(late)} ms`, {
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    }
    // A stall the event loop survives is logged above; a stall that never
    // returns writes nothing at all, and the file would just stop at an
    // arbitrary line. One heartbeat a minute bounds the time of death: the last
    // one says the process was alive then, and the silence afterwards is the
    // evidence.
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      const mem = process.memoryUsage();
      write('debug', 'heartbeat', 'alive', {
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        loop_lag_ms: Math.round(Math.max(0, late)),
      });
    }
    expected = now + intervalMs;
  }, intervalMs);
  timer.unref?.();
  return timer;
}
