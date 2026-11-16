import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { log } from './log.js';

/**
 * Bridges the local Python gesture service to the renderer.
 *
 * The service is a separate process on purpose: MediaPipe/CV2 are heavy and
 * crash-prone, and a crash there must never take the desktop app down with it.
 * We only ever forward small JSON status messages; no frame data crosses this
 * boundary, and nothing leaves the machine.
 */

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
  /** The same four fingers measured in MediaPipe's metric 3D world landmarks. */
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
  /** Any hand at all was detected (may be the left, which must not drive the pointer). */
  handDetected: boolean;
  /** True only when the tracked hand is the right one. */
  rightHand: boolean;
  /** Mean brightness of the camera frame the landmarkers just saw (0-255). */
  cameraMean: number;
  /** True when the camera stream is delivering black frames, not an empty room. */
  cameraDark: boolean;
  faceVisible: boolean;
  /** Which hand the pointer is following, as MediaPipe labels it. */
  handLabel: string;
  /** True once a neutral palm pose has been captured, so the aim is offset-free. */
  calibrated: boolean;
  /** Where the head is turned: the screen that owns the next released window. */
  gaze: GazeReading | null;
  confidence: number;
  landmarks: {
    hand: number[][];
    face: number[][];
    /**
     * Every hand the tracker found, labelled, so the preview can draw both. A
     * hand that is detected but not driving the cursor (the left one) is still a
     * hand the user expects to see.
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
  /** The screen currently being looked at, or null in the dead zone. */
  target: GazeTarget | null;
  /** Where a released window goes; null when the reading cannot be trusted. */
  releaseTarget: GazeTarget | null;
  /**
   * `calibrated` uses the two recorded head angles, `default` uses the
   * camera-relative split (facing the laptop vs. turned away) before any
   * calibration, `invalid` means saved anchors cannot separate the screens.
   */
  mode: 'calibrated' | 'default' | 'invalid';
  /** Head yaw in degrees, smoothed. */
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

/**
 * One hand-pointer frame from the Python service.
 *
 * This is a separate, high-rate stream from `status`: the OS cursor wants ~30 Hz
 * to feel direct, while the UI only needs the 12 Hz status snapshot. Sending the
 * cursor through `status` would re-render React at 30 Hz for no benefit.
 */
export interface PointerFrameMessage {
  /** Hand position in screen fractions, or null when no hand is visible. */
  x: number | null;
  y: number | null;
  handVisible: boolean;
  pinch: boolean;
  /** True while thumb + index + middle are pinched: the wheel gesture. */
  scrolling: boolean;
  /** False while hand control is disarmed: do not move the OS cursor. */
  armed: boolean;
  /** Which screen the head is on, decided by the same router as window releases. */
  gaze: 'laptop' | 'tablet' | null;
  at: number;
}

export type ServiceState = 'stopped' | 'starting' | 'running' | 'failed';

const PORT = 8790;
const WS_URL = `ws://127.0.0.1:${PORT}`;

/** How long to wait for the Python service before reporting failure. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Delay between stopping the old service and spawning the new one. On Windows
 * `stop()` schedules a forced `taskkill` 1.5s after the polite kill, so the new
 * process must not start before that has had a chance to run: it would find the
 * camera and port 8790 still taken by its predecessor.
 */
const RESTART_DELAY_MS = 2_000;

/**
 * Retry budget for the "port / camera still held" case.
 *
 * A predecessor that is slow to die, or another app mid-release of the webcam,
 * used to exhaust the two generic restarts and leave the bridge on `failed`
 * until the user restarted ORBIT. Those failures are transient, so they get
 * their own longer budget with backoff.
 */
const BUSY_RETRY_LIMIT = 8;
const BUSY_RETRY_BASE_MS = 1_500;
/** Retries keep going at this interval once the backoff has grown to it. */
const BUSY_RETRY_MAX_MS = 4_000;

/** How long to wait for port 8790 to become free before giving up on a spawn. */
const PORT_WAIT_TIMEOUT_MS = 10_000;
const PORT_POLL_MS = 250;

/** A stale service from a previous run leaves this text in stderr. */
const BUSY_RE =
  /cannot bind port|address already in use|only one usage of each socket address|EADDRINUSE|Could not open (?:the |a )?camera|port already in use|busy/i;

/**
 * The import probe that proves an interpreter has the gesture dependencies.
 *
 * Any installed Python may be first on PATH — this machine has 3.10 (with the
 * packages) and 3.13 (without). Picking the first name and hoping is how the
 * app ends up spawning a broken service, which surfaces to the user as a
 * camera failure that has nothing to do with the camera.
 */
const PYTHON_PROBE = 'import mediapipe, cv2, websockets';

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a short-lived helper process without blocking the main process.
 *
 * `killStaleService` and `findPython` used `spawnSync`, which stops the Electron
 * main thread dead while PowerShell starts. Reaping an orphan can take seconds,
 * and probing four interpreters ten seconds each, so a retry during normal use
 * froze the entire UI with no log line explaining it. The main thread is the one
 * that services the pointer stream too, so a blocked probe also stopped the
 * cursor. Everything here is asynchronous.
 */
function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      done({ code, stdout, stderr, timedOut });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      // Bounded: a broken helper that prints forever must not exhaust memory.
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr += String(error);
      finish(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

export class GestureBridge extends EventEmitter {
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopping = false;
  private pythonPath: string | null = null;
  private lastError: string | null = null;
  private lastServiceError: string | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  /** Bumped by stop(), so a pending restart can tell it was superseded. */
  private stopToken = 0;
  /** Consecutive failures that look like "port or camera still held". */
  private busyAttempts = 0;
  /** Pending port-release wait, so a stop() can cancel it. */
  private portWaitTimer: NodeJS.Timeout | null = null;
  /** True while a busy-retry timer is queued, so two paths cannot both schedule. */
  private retryQueued = false;
  /** True once the user has been told we are still waiting; avoids re-notifying. */
  private busyWarned = false;
  /** True for the whole "waiting for port/camera" cycle, including port polling. */
  private busyCycle = false;
  /** In-flight interpreter probe, shared so two callers cannot probe twice. */
  private pythonProbe: Promise<string | null> | null = null;

  state: ServiceState = 'stopped';
  status: GestureStatus | null = null;

  constructor(private repoRoot: string) {
    super();
  }

  /** Locate the service script relative to the app, in dev and in a build. */
  private serviceDir(): string | null {
    const candidates = [
      resolve(this.repoRoot, 'services/gestures'),
      // Packaged layout: resources/services/gestures
      resolve(process.resourcesPath ?? '', 'services/gestures'),
    ];
    return candidates.find((dir) => existsSync(join(dir, 'serve.py'))) ?? null;
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.state === 'running' || this.state === 'starting') {
      return { ok: true, message: 'Gesture service is already starting.' };
    }
    return this.launch();
  }

  /**
   * Force a fresh service process, whatever the current state.
   *
   * The common reason to press "Retry camera" is that another app (Zoom, Teams)
   * was holding the webcam when we first tried. The usual failure path has
   * already exhausted its two automatic restarts and settled on `failed`, and
   * `start()` deliberately refuses to relaunch from there only when a process is
   * already up — so a retry has to tear the old one down first.
   */
  async restart(): Promise<{ ok: boolean; message: string }> {
    const dir = this.serviceDir();
    if (!dir) {
      this.fail('Gesture service files are missing from this installation.');
      return { ok: false, message: this.lastError! };
    }

    // Report the restart immediately; the interpreter probe below is async and
    // must not block the UI or the pointer stream while it runs.
    this.setState('starting');
    const python = await this.findPython();
    if (!python) {
      this.fail(
        'Python 3 with the gesture dependencies was not found. Install Python 3.10+ and run: pip install mediapipe opencv-python websockets (see services/gestures/README.md).',
      );
      return { ok: false, message: this.lastError! };
    }

    // Tear the old process down before starting a new one: it holds the camera
    // and port 8790, so a replacement would fail to bind or see a busy webcam.
    //
    // This deliberately does *not* call stop(). stop() leaves `stopping` set and
    // the outgoing child's exit handler calls setState('stopped') and
    // closeSocket() — both of which would land *after* the replacement is up and
    // silently knock it back to stopped. Instead we detach the old child's
    // listeners so its exit is inert, then start fresh.
    this.killChild('restart');
    this.stopping = false;
    this.attempt = 0;
    this.lastError = null;
    this.lastServiceError = null;
    this.setState('starting');

    const token = (this.stopToken += 1);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopToken !== token) return; // a real stop() superseded us
      this.spawnWhenPortFree(python, dir, token);
    }, RESTART_DELAY_MS);

    log.info('gestures', 'Restart requested.', { python, dir });
    return { ok: true, message: 'Restarting the camera.' };
  }

  /** Kill the current service process without touching bridge state. */
  private killChild(reason: string): void {
    this.closeSocket();
    const child = this.child;
    this.child = null;
    if (!child) return;
    log.info('gestures', `Stopping the gesture service (${reason}).`, { pid: child.pid });

    // Detach first: this child's exit must not mutate state or close the socket
    // of the process that replaces it.
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.on('error', () => undefined);

    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    try {
      child.kill();
    } catch {
      /* already gone */
    }

    if (process.platform === 'win32' && child.pid) {
      // The camera thread keeps Python alive past SIGTERM; kill the tree.
      setTimeout(() => {
        if (exited) return;
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            stdio: 'ignore',
            windowsHide: true,
          }).on('error', () => undefined);
        } catch {
          /* already gone */
        }
      }, 1200).unref();
    } else {
      setTimeout(() => {
        if (exited) return;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1200).unref();
    }
  }

  private async launch(): Promise<{ ok: boolean; message: string }> {
    const dir = this.serviceDir();
    if (!dir) {
      this.fail('Gesture service files are missing from this installation.');
      // Report the failure in the return value too, so the UI can show the real
      // reason instead of a perpetual "Starting..." state.
      return { ok: false, message: this.lastError! };
    }

    // Prove the interpreter asynchronously. This probe is what used to freeze
    // the whole app for up to ten seconds per candidate interpreter.
    const python = await this.findPython();
    if (!python) {
      this.fail(
        'Python 3 with the gesture dependencies was not found. Install Python 3.10+ and run: pip install mediapipe opencv-python websockets (see services/gestures/README.md).',
      );
      return { ok: false, message: this.lastError! };
    }
    if (this.stopping) {
      return { ok: false, message: 'The gesture service was stopped while starting.' };
    }
    log.info('gestures', 'Starting the gesture service.', { python, dir });

    this.stopping = false;
    this.attempt = 0;
    this.busyAttempts = 0;
    this.busyWarned = false;
    this.busyCycle = false;
    this.retryQueued = false;
    this.lastServiceError = null;
    this.setState('starting');
    const token = (this.stopToken += 1);
    this.spawnWhenPortFree(python, dir, token);
    return { ok: true, message: 'Starting camera and gesture recognition.' };
  }

  /**
   * Resolve true when nothing is listening on 8790.
   *
   * A bind() failure is the failure mode this class handles worst: Python only
   * reports it *after* the MediaPipe models load, so it looks like a mysterious
   * crash several seconds in. Checking first turns that into a wait.
   */
  private portIsFree(): Promise<boolean> {
    return new Promise((done) => {
      const server = net.createServer();
      server.once('error', () => done(false));
      server.once('listening', () => server.close(() => done(true)));
      try {
        server.listen(PORT, '127.0.0.1');
      } catch {
        done(false);
      }
    });
  }

  /**
   * Queue another attempt after a transient busy failure, with linear backoff.
   *
   * Shared by the port-wait timeout and the "process died with EADDRINUSE / webcam
   * busy" exit path so both behave the same way. Stays in `starting` rather than
   * flashing `failed`, because the service is in fact still coming up.
   */
  private scheduleBusyRetry(dir: string, token: number): void {
    // Only one retry may be in flight. Both the exit handler and the port-wait
    // timeout can reach here for the same failure, and the second call used to
    // cancel/replace the first — which is what made the state flicker between
    // `starting` and `failed`.
    if (this.retryQueued) return;

    if (this.busyAttempts >= BUSY_RETRY_LIMIT && !this.busyWarned) {
      // Keep retrying, but stop pretending this is routine: report the reason to
      // the user once, while still retrying in the background. Going terminal
      // here is what forced a full app reload before.
      this.busyWarned = true;
      this.lastError =
        `Still waiting to start the gesture service: ${this.lastServiceError ?? `port ${PORT} is in use`}. ` +
        'Close any other app using the camera, or press Restart camera.';
      this.emit('error', this.lastError);
    }
    this.busyAttempts = Math.min(this.busyAttempts + 1, BUSY_RETRY_LIMIT);
    this.busyCycle = true;
    // Linear backoff that caps out, rather than a budget that runs dry. A port
    // held for longer than the early retries must not become a terminal failure:
    // the user's instruction was to recover on its own rather than require a
    // reload, and "another app is still releasing the webcam" can take a while.
    const backoff = Math.min(BUSY_RETRY_BASE_MS * this.busyAttempts, BUSY_RETRY_MAX_MS);
    this.setState('starting');
    this.retryQueued = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.retryQueued = false;
      if (this.stopping || this.stopToken !== token) return;
      void (async () => {
        const python = await this.findPython();
        if (this.stopping || this.stopToken !== token) return;
        if (!python) {
          this.fail('Python 3 with the gesture dependencies was not found.');
          return;
        }
        // A leftover service may still be holding the camera even after its port
        // was released (or it may never have bound it). Reap it before the next
        // attempt, otherwise every retry fails to open the same device.
        await this.killStaleService(true);
        if (this.stopping || this.stopToken !== token) return;
        this.spawnWhenPortFree(python, dir, token);
      })();
    }, backoff);
  }

  /**
   * Kill a gesture service left behind by a previous ORBIT run.
   *
   * A crashed or force-quit app can leave the Python service holding both port
   * 8790 and the webcam. From the user's point of view no application is using
   * the camera, yet every new launch fails to open it — and the old process is
   * invisible. Kill it before giving up, but only when the owner is actually our
   * `serve.py`: another program on 8790 must never be touched. With
   * `includeCameraHolders`, a Python process running `serve.py` is reaped even
   * when it no longer owns the port, because it may still hold the webcam.
   */
  private async killStaleService(includeCameraHolders = false): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    // Prefer the process that owns the port. When the port is already free
    // but startup still fails to open the camera, fall back to any Python
    // process whose command line is our service — that is an orphan that
    // released the port without releasing the camera handle.
    const script = includeCameraHolders
      ? '$procs = Get-CimInstance Win32_Process -Filter "Name=\'python.exe\' OR Name=\'python3.exe\' OR Name=\'py.exe\'" -ErrorAction SilentlyContinue; ' +
        'foreach ($proc in $procs) { ' +
        "if ($proc.CommandLine -match 'services[\\\\/]gestures[\\\\/]serve\\.py') { Write-Output $proc.ProcessId } }"
      : '$pids = Get-NetTCPConnection -LocalPort ' +
        PORT +
        ' -State Listen -ErrorAction SilentlyContinue | ' +
        'Select-Object -ExpandProperty OwningProcess -Unique; ' +
        'foreach ($p in $pids) { ' +
        '$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; ' +
        "if ($proc -and $proc.CommandLine -match 'services[\\\\/]gestures[\\\\/]serve\\.py') { Write-Output $p } }";

    // Asynchronous on purpose: this used to run `spawnSync` inside the promise
    // executor, so starting PowerShell blocked the main thread and the pointer
    // stream for the full duration of the query.
    const result = await runProcess('powershell', ['-NoProfile', '-Command', script], 8_000);
    if (result.timedOut) {
      log.warn('gestures', 'Timed out while looking for a stale gesture service.');
    }
    const pids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line) && line !== '0');
    if (pids.length === 0) return false;

    await Promise.all(
      pids.map(async (pid) => {
        const killed = await runProcess('taskkill', ['/F', '/T', '/PID', pid], 5_000);
        if (killed.code !== 0) {
          log.warn('gestures', `Could not stop stale gesture service pid ${pid}.`, killed.stderr.trim());
        }
      }),
    );
    log.info('gestures', `Stopped a stale gesture service (pid ${pids.join(', ')}) so the camera can be reopened.`);
    return true;
  }

  /**
   * Spawn the service once port 8790 is actually free.
   *
   * If a predecessor is still shutting down we poll briefly instead of spawning
   * into a guaranteed EADDRINUSE. If the port never frees, treat it as a busy
   * failure so the backoff path can take over rather than hanging.
   */
  private spawnWhenPortFree(python: string, dir: string, token: number): void {
    if (this.portWaitTimer) clearTimeout(this.portWaitTimer);
    const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;
    // Only try to reap an orphan once per spawn; a second pass would be an
    // endless kill/retry loop against a process that is not ours.
    let reaped = false;

    const attempt = (): void => {
      this.portWaitTimer = null;
      if (this.stopToken !== token || this.stopping) return;
      void this.portIsFree().then((free) => {
        if (this.stopToken !== token || this.stopping) return;
        if (free) {
          this.spawnService(python, dir);
          return;
        }
        if (!reaped) {
          reaped = true;
          void this.killStaleService().then(() => {
            if (this.stopToken !== token || this.stopping) return;
            attempt();
          });
          return;
        }
        if (Date.now() >= deadline) {
          this.lastServiceError = `Port ${PORT} is still in use by another process.`;
          // Route into the busy backoff rather than giving up. Giving up here is
          // what left the app on `failed` until it was reopened: a predecessor
          // (or another app) holding the port for a few seconds longer than the
          // wait window is a transient condition, not a hopeless one.
          this.scheduleBusyRetry(dir, token);
          return;
        }
        this.portWaitTimer = setTimeout(attempt, PORT_POLL_MS);
      });
    };
    attempt();
  }

  private spawnService(python: string, dir: string): void {
    // Pass the absolute script path, not a bare `serve.py`. The command line is
    // how killStaleService proves a process is ours; a bare name would match
    // anyone else's serve.py and risk killing an unrelated program.
    const child = spawn(python, [join(dir, 'serve.py')], {
      cwd: dir,
      env: {
        ...process.env,
        ORBIT_GESTURE_PORT: String(PORT),
        PYTHONIOENCODING: 'utf-8',
        // Keep MediaPipe from spawning extra threads that fight the UI.
        OMP_NUM_THREADS: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;
    let stderrBuf = '';
    /** Last stderr line logged, so a repeating warning cannot flood the file. */
    let lastStderr = '';

    log.info('gestures', 'Gesture service process started.', { pid: child.pid, python, dir });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf = (stderrBuf + text).slice(-4000);
      // Persist every line the service writes. This is the only place the
      // Python side can tell us why it stopped, and these lines used to be
      // thrown away unless they matched an error pattern.
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line === lastStderr) continue;
        lastStderr = line;
        const bad = /(traceback|RuntimeError|ImportError|ModuleNotFoundError|Could not open (?:the |a )?camera|error:)/i.test(
          line,
        );
        if (bad) log.error('gestures-py', line);
        else log.info('gestures-py', line);
      }
      // Surface only real failures, not MediaPipe's noisy INFO/W0000 chatter.
      if (
        /(traceback|RuntimeError|ImportError|ModuleNotFoundError|Could not open (?:the |a )?camera|error:)/i.test(
          text,
        )
      ) {
        // Keep the last real failure so a startup timeout can explain itself.
        this.lastServiceError = text.trim().split('\n').slice(-3).join(' ');
      }
    });

    // stdout is piped, so it must be drained even though the service is not
    // expected to write there.
    //
    // Reported as "it just freezes sometimes". A child that writes more than the
    // OS pipe buffer (~64 KB) blocks forever in its next `write` when nobody is
    // reading. MediaPipe and its native libraries do print to stdout on some
    // builds, and when that happened the Python service stopped producing
    // frames: the cursor froze, the camera preview froze, and there was no log
    // line anywhere because a blocked pipe is not an error.
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) log.info('gestures-out', text.length > 1000 ? `${text.slice(0, 1000)}…` : text);
    });

    child.on('error', (error) => {
      log.error('gestures', 'Could not start the gesture service.', error);
      this.fail(`Could not start the gesture service: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      log.warn('gestures', 'Gesture service exited.', {
        code,
        signal,
        pid: child.pid,
        last: stderrBuf.trim().split('\n').slice(-5).join(' | '),
      });
      this.child = null;
      this.closeSocket();
      if (this.stopping) {
        this.setState('stopped');
        return;
      }
      const detail = stderrBuf.split('\n').filter((l) => /error|camera|traceback/i.test(l)).slice(-3).join(' ');

      // "Address already in use" and "camera busy" are transient: a predecessor
      // is still dying, or another app is mid-release of the webcam. Retrying
      // these on the short generic budget used to leave the bridge on `failed`
      // until the user reopened ORBIT, so they get their own backoff instead.
      const busy = BUSY_RE.test(stderrBuf) || BUSY_RE.test(detail);
      if (busy) {
        this.lastServiceError = detail || `Port ${PORT} was still in use.`;
        const busyDir = this.serviceDir();
        if (busyDir) {
          this.scheduleBusyRetry(busyDir, this.stopToken);
          return;
        }
      }

      this.fail(
        `The gesture service stopped unexpectedly (${signal ?? code}). ${detail}`.trim(),
      );
      // One automatic restart, then stay failed so the UI can explain it.
      if (this.attempt < 2 && !this.retryQueued) {
        this.attempt += 1;
        const token = this.stopToken;
        this.retryQueued = true;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.retryQueued = false;
          const dir = this.serviceDir();
          void this.findPython().then((python) => {
            if (dir && python && !this.stopping && this.stopToken === token) {
              this.setState('starting');
              this.spawnWhenPortFree(python, dir, token);
            }
          });
        }, 2500);
      }
    });

    this.connect();
  }

  private connect(): void {
    this.closeSocket();
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      log.info('gestures', 'Connected to the gesture service.');
      this.setState('running');
      this.attempt = 0;
      this.busyAttempts = 0;
      this.retryQueued = false;
      this.busyWarned = false;
      this.busyCycle = false;
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      // One malformed or unexpected message must not throw out of a WebSocket
      // handler. Before this guard the throw reached the global exception
      // handler, which kept the app alive but dropped the frame and left no
      // trace of what the service sent.
      try {
        if (msg.type === 'status') {
          if (msg.initial) return;
          this.status = normaliseStatus(msg);
          this.emit('status', this.status);
        } else if (msg.type === 'event') {
          this.emit('event', {
            kind: String(msg.kind ?? ''),
            phase: String(msg.phase ?? 'inactive') as GesturePhase,
            message: String(msg.message ?? ''),
            at: Number(msg.at ?? Date.now()),
            detail: (msg.detail as Record<string, unknown>) ?? {},
          } satisfies GestureEventMessage);
        } else if (msg.type === 'pointer') {
          // High-rate cursor frames. The main process consumes these directly;
          // they are deliberately not forwarded to the renderer, which would
          // re-render at 30 Hz just to draw a cursor the OS already draws.
          const gaze = msg.gaze === 'laptop' || msg.gaze === 'tablet' ? msg.gaze : null;
          const num = (value: unknown): number | null => {
            const n = Number(value);
            return typeof value === 'number' && Number.isFinite(n) ? n : null;
          };
          this.emit('pointer', {
            x: num(msg.x),
            y: num(msg.y),
            handVisible: Boolean(msg.handVisible),
            pinch: Boolean(msg.pinch),
            scrolling: Boolean(msg.scrolling),
            // Older service builds omitted the field; they still move the cursor.
            armed: msg.armed === undefined ? true : Boolean(msg.armed),
            gaze,
            at: Number(msg.at ?? Date.now()),
          } satisfies PointerFrameMessage);
        } else if (msg.type === 'error') {
          this.fail(String(msg.message ?? 'Gesture service reported an error.'));
        }
      } catch (error) {
        log.error('gestures', `Dropped a ${String(msg.type)} message that could not be handled.`, error);
      }
    });

    ws.on('error', (error) => {
      // A failed connect means the Python side is not up yet. `close` fires
      // right after this and schedules the retry. Still record it: a socket
      // that fails for another reason is invisible otherwise.
      log.warn('gestures', `Gesture socket error: ${error.message}`);
    });

    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      log.warn('gestures', 'Gesture socket closed.', { code, reason: reason.toString() });
      // Retry whenever the service is supposed to be coming up. Previously this
      // only retried after a successful connect (`running`), so if the very
      // first attempt lost the race against Python loading MediaPipe, the UI sat
      // on "Starting..." forever even though the camera had opened.
      if (!this.stopping && (this.state === 'running' || this.state === 'starting')) {
        this.scheduleConnectRetry();
      }
    });

    // Never hang silently: if we are still not connected after the grace period,
    // say so with an actionable message instead of spinning forever.
    //
    // While a busy-retry cycle is in progress there is deliberately no service to
    // connect to, so this must not declare failure: doing that is what flashed
    // `failed` in the middle of what was actually a healthy wait for the port.
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      if (this.state === 'starting' && !this.stopping && !this.retryQueued && !this.busyCycle) {
        // Do not blame the camera here. A timeout is equally likely to be a
        // missing dependency, a bad interpreter or a slow first model load, and
        // telling the user another app holds the webcam sends them chasing the
        // wrong thing. Quote the service's own error when there is one.
        const detail = this.lastServiceError
          ? ` Last error: ${this.lastServiceError}`
          : ' No error was reported by the service.';
        this.fail(
          `The gesture service did not start within ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s.${detail} ` +
            'Press Restart camera; if it keeps failing, check the Python install and the Windows camera privacy settings.',
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private scheduleConnectRetry(): void {
    if (this.retry || this.stopping) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopping && this.state !== 'stopped') this.connect();
    }, 1200);
  }

  arm(): boolean {
    return this.command({ t: 'gesture.arm' });
  }

  disarm(): boolean {
    return this.command({ t: 'gesture.disarm' });
  }

  /**
   * Ask the service to adopt the palm pose being held right now as "aiming at
   * the middle of the screen". The service captures it from the latest frame,
   * so this is fire-and-forget: the result arrives as a `pointer.calibrate`
   * event rather than as a return value.
   */
  calibrate(): boolean {
    return this.command({ t: 'gesture.calibrate' });
  }

  /**
   * Record where the head is pointing now as one of the two screens. The
   * service needs both anchors before it will route anything, so the UI
   * exposes one button per screen.
   */
  calibrateGaze(target: GazeTarget): boolean {
    return this.command({ t: 'gaze.calibrate', target });
  }

  private command(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    log.info('gestures', 'Stop requested.');
    this.stopping = true;
    this.stopToken += 1;
    if (this.portWaitTimer) clearTimeout(this.portWaitTimer);
    this.portWaitTimer = null;
    this.busyAttempts = 0;
    this.retryQueued = false;
    this.busyWarned = false;
    this.busyCycle = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.retry) clearTimeout(this.retry);
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.restartTimer = null;
    this.retry = null;
    this.connectTimeout = null;
    this.closeSocket();

    const child = this.child;
    this.child = null;
    if (child) {
      // Ask politely first, then make sure it is gone.
      //
      // `child.killed` only reports whether a signal was sent, not whether the
      // process died, and on Windows a Python process holding a camera handle
      // often survives a plain kill(). That left orphaned services bound to
      // 8790, so the next launch could connect to a stale one. Check the exit
      // code instead and force the whole tree on Windows.
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });

      try {
        child.kill();
      } catch {
        /* already gone */
      }

      if (process.platform === 'win32' && child.pid) {
        // The camera thread keeps the process alive past SIGTERM; kill the tree.
        setTimeout(() => {
          if (exited) return;
          try {
            spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
              stdio: 'ignore',
              windowsHide: true,
            }).on('error', () => undefined);
          } catch {
            /* already gone */
          }
        }, 1500).unref();
      } else {
        setTimeout(() => {
          if (!exited) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }, 1500).unref();
      }
    }
    this.setState('stopped');
  }

  private closeSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try {
      // Keep an error handler attached until after close(): closing a socket that
      // is still connecting emits 'error' asynchronously, and with no listener
      // that becomes an unhandled exception that would take Electron's main
      // process down (seen when stopping while the service was still starting).
      ws.removeAllListeners('open');
      ws.removeAllListeners('message');
      ws.removeAllListeners('close');
      ws.removeAllListeners('error');
      ws.on('error', () => undefined);
      ws.close();
    } catch {
      /* closing is best effort */
    }
  }

  private fail(message: string): void {
    log.error('gestures', message);
    this.lastError = message;
    this.setState('failed');
    this.emit('error', message);
  }

  private setState(state: ServiceState): void {
    if (this.state === state) return;
    log.info('gestures', `State: ${this.state} -> ${state}.`, this.lastError ? { error: this.lastError } : undefined);
    this.state = state;
    this.emit('state', state, this.lastError);
  }

  /**
   * Pick an interpreter that can actually import the gesture stack.
   *
   * `ORBIT_PYTHON` is set by the launcher after it has already run this probe,
   * so it is trusted. Otherwise every plausible name is tested: taking the
   * first `python` on PATH is not enough on machines with more than one
   * install, and a wrong one fails later as a startup/camera error.
   */
  private findPython(): Promise<string | null> {
    if (this.pythonPath) return Promise.resolve(this.pythonPath);
    // Share one probe. Two callers (a user pressing Restart while a busy retry
    // fires) used to run the whole probe twice, serially, on the main thread.
    if (!this.pythonProbe) {
      this.pythonProbe = this.probePython().finally(() => {
        this.pythonProbe = null;
      });
    }
    return this.pythonProbe;
  }

  private async probePython(): Promise<string | null> {
    const explicit = process.env.ORBIT_PYTHON;
    if (explicit) {
      if (!explicit.includes('\\') && !explicit.includes('/')) {
        this.pythonPath = explicit;
        return explicit;
      }
      if (existsSync(explicit)) {
        this.pythonPath = explicit;
        return explicit;
      }
    }

    const candidates = ['python', 'python3', 'py', 'C:\\Program Files\\Python310\\python.exe'];
    for (const candidate of candidates) {
      if (candidate.includes('\\') && !existsSync(candidate)) continue;
      // A short timeout: a Store-alias or broken install must not stall the
      // whole app while we are only deciding which interpreter to use.
      const result = await runProcess(candidate, ['-c', PYTHON_PROBE], 10_000);
      if (result.code === 0) {
        log.info('gestures', 'Interpreter probe succeeded.', { python: candidate });
        this.pythonPath = candidate;
        return candidate;
      }
      if (result.timedOut) {
        log.warn('gestures', 'Interpreter probe timed out.', { python: candidate });
      }
    }
    log.error('gestures', 'No Python interpreter with mediapipe, cv2 and websockets was found.');
    return null;
  }
}

function normaliseRay(value: unknown): GestureRay | null {
  if (!value || typeof value !== 'object') return null;
  const ray = value as Record<string, unknown>;
  const normal = Array.isArray(ray.normal) && ray.normal.length >= 3
    ? ([Number(ray.normal[0] ?? 0), Number(ray.normal[1] ?? 0), Number(ray.normal[2] ?? 0)] as [
        number,
        number,
        number,
      ])
    : null;
  const hit = Array.isArray(ray.hit) && ray.hit.length >= 2
    ? ([Number(ray.hit[0] ?? 0), Number(ray.hit[1] ?? 0)] as [number, number])
    : null;
  if (!normal || !hit) return null;
  return { normal, hit };
}

function normaliseTarget(value: unknown): GazeTarget | null {
  return value === 'laptop' || value === 'tablet' ? value : null;
}

function normaliseGazeMode(value: unknown): GazeReading['mode'] {
  return value === 'calibrated' || value === 'invalid' ? value : 'default';
}

function normaliseGaze(value: unknown): GazeReading | null {
  if (!value || typeof value !== 'object') return null;
  const gaze = value as Record<string, unknown>;
  return {
    target: normaliseTarget(gaze.target),
    releaseTarget: normaliseTarget(gaze.releaseTarget),
    mode: normaliseGazeMode(gaze.mode),
    yaw: typeof gaze.yaw === 'number' ? gaze.yaw : null,
    pitch: typeof gaze.pitch === 'number' ? gaze.pitch : null,
    calibrated: Boolean(gaze.calibrated),
    laptopYaw: typeof gaze.laptopYaw === 'number' ? gaze.laptopYaw : null,
    tabletYaw: typeof gaze.tabletYaw === 'number' ? gaze.tabletYaw : null,
    samples: Number(gaze.samples ?? 0),
  };
}

function normaliseStatus(msg: Record<string, unknown>): GestureStatus {
  const machine = (msg.machine as Record<string, unknown>) ?? {};
  const landmarks = (msg.landmarks as Record<string, unknown>) ?? {};
  const resolution = Array.isArray(msg.resolution) ? msg.resolution : [0, 0];
  const numberList = (value: unknown): number[] =>
    Array.isArray(value)
      ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      : [];
  return {
    phase: (String(machine.phase ?? 'inactive') as GesturePhase),
    armed: Boolean(machine.armed),
    atMouth: Boolean(msg.atMouth),
    inFront: Boolean(msg.inFront),
    curled: Boolean(msg.curled),
    curl: Number(msg.curl ?? 0),
    fingerCurls: numberList(msg.fingerCurls),
    fingerCurls3d: numberList(msg.fingerCurls3d),
    pinch: Boolean(msg.pinch),
    scrolling: Boolean(msg.scrolling),
    pinchDistance: typeof msg.pinchDistance === 'number' ? msg.pinchDistance : null,
    pointer: Array.isArray(msg.pointer)
      ? ([Number(msg.pointer[0] ?? 0), Number(msg.pointer[1] ?? 0)] as [number, number])
      : null,
    pointerReason: String(msg.pointerReason ?? ''),
    ray: normaliseRay(msg.ray),
    palm: Array.isArray(msg.palm)
      ? ([Number(msg.palm[0] ?? 0), Number(msg.palm[1] ?? 0)] as [number, number])
      : null,
    distance: typeof msg.distance === 'number' ? msg.distance : null,
    reason: String(msg.reason ?? ''),
    handVisible: Boolean(msg.handVisible),
    handDetected: Boolean(msg.handDetected ?? msg.handVisible),
    rightHand: Boolean(msg.rightHand ?? msg.handVisible),
    // Older service builds omitted these; a frame is assumed healthy then, so a
    // stale build never shows a false "camera is black" warning.
    cameraMean: typeof msg.cameraMean === 'number' ? msg.cameraMean : -1,
    cameraDark: Boolean(msg.cameraDark),
    faceVisible: Boolean(msg.faceVisible),
    handLabel: String(msg.handLabel ?? ''),
    calibrated: Boolean(msg.calibrated),
    gaze: normaliseGaze(msg.gaze),
    confidence: Number(msg.confidence ?? 0),
    landmarks: {
      hand: Array.isArray(landmarks.hand) ? (landmarks.hand as number[][]) : [],
      face: Array.isArray(landmarks.face) ? (landmarks.face as number[][]) : [],
      // Passed through rather than whitelisted field by field: the preview only
      // needs the points and a label, and dropping this key here is exactly why
      // the left hand kept not being drawn even after the service started
      // sending it. A missing value stays `undefined` so the renderer can fall
      // back to the single `hand` above.
      hands: Array.isArray(landmarks.hands)
        ? (landmarks.hands as { label: string; points: number[][] }[])
        : undefined,
    },
    resolution: [Number(resolution[0] ?? 0), Number(resolution[1] ?? 0)],
    frames: Number(msg.frames ?? 0),
    fps: Number(msg.fps ?? 0),
    error: msg.error ? String(msg.error) : null,
  };
}
