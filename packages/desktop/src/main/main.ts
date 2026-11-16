import { app, BrowserWindow, desktopCapturer, screen, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerIpc } from './ipc.js';
import { OrbitClient } from './client.js';
import { Settings } from './settings.js';
import { GestureBridge } from './gestures.js';
import { SystemPointer } from './system-pointer.js';
import { initLogging, log, logFile, startFreezeWatchdog } from './log.js';
import { carryIndicator } from './carry-indicator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Open the log before anything else can fail. Everything below reports into it,
// so a freeze or crash leaves a file behind even when the terminal is gone.
initLogging();
startFreezeWatchdog();

const isDev = !app.isPackaged;
const rendererUrl = process.env.ORBIT_RENDERER_URL ?? 'http://localhost:5173';
/** Repo root in dev; unpacked resources in a packaged build. */
const repoRoot = isDev ? join(__dirname, '../../../..') : process.resourcesPath;

let mainWindow: BrowserWindow | null = null;
let client: OrbitClient | null = null;
let gestures: GestureBridge | null = null;
let systemPointer: SystemPointer | null = null;

app.commandLine.appendSwitch('force_high_performance_gpu');
// Media keys and background audio keep working while a panel is shared.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Single instance: a second launch focuses the existing window.
//
// This used to be a bare `app.quit()` with no message. When a previous instance
// was still shutting down, a relaunch lost the lock race, exited immediately and
// the launcher reported only "the desktop app exited with code 1" — the user
// saw the app refuse to start with no explanation anywhere.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  log.warn('app', 'Another ORBIT instance already owns the single-instance lock; exiting this one.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('app', 'Second launch redirected to the running window.');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1280, Math.round(width * 0.82)),
    height: Math.min(860, Math.round(height * 0.86)),
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#08090c',
    title: 'ORBIT',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Screen capture in the renderer is gated per-frame by setDisplayMediaRequestHandler.
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    log.info('window', 'Renderer ready; showing the window.');
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    log.info('window', 'Window closed.');
    // The carry overlay is a second visible window, and `window-all-closed` only
    // fires once every window is gone. Destroying it first keeps "close ORBIT" a
    // single action instead of leaving a ghost ring on the desktop and a process
    // that will not exit.
    carryIndicator().destroy();
    mainWindow = null;
  });

  // A renderer that dies or stops painting used to leave a window that looked
  // alive but ignored every click — indistinguishable from a main-process
  // freeze, and with nothing in any log. Record the cause, then recover once so
  // the user does not have to restart the whole app.
  let reloads = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('window', `Renderer gone: ${details.reason} (exit ${details.exitCode}).`);
    if (details.reason === 'clean-exit') return;
    if (reloads >= 2) {
      log.error('window', 'Renderer keeps dying; leaving the window as-is instead of reloading again.');
      return;
    }
    reloads += 1;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      log.info('window', `Reloading the renderer after a crash (attempt ${reloads}).`);
      mainWindow.reload();
    }, 400);
  });
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('window', 'Renderer reported unresponsive.');
  });
  mainWindow.webContents.on('responsive', () => {
    log.info('window', 'Renderer responded again.');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.error('window', `Renderer failed to load (${code} ${description}).`, { url });
  });

  // Never let the app navigate away from its own UI, and send external links to
  // the system browser instead. This is a prompt-injection guard too.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(rendererUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (isDev) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function configurePermissions(): void {
  // Camera is needed for local gesture detection later; deny everything else a
  // page never legitimately needs in this app.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = new Set(['media', 'clipboard-sanitized-write', 'display-capture']);
    callback(allowed.has(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
}

/**
 * Never let a single bad gesture frame freeze the app.
 *
 * Reported: "when I disable control of mouse pointer with hand to recenter
 * cursor and then enable it back, and then pinch, the app just crashes.
 * Everything just freezes and I have to close and reopen it."
 *
 * There was no uncaughtException or unhandledRejection handler anywhere in the
 * main process, so one throw inside a gesture handler took the whole process
 * down with no message and no recovery path. In a normal app that is a crash
 * dialog; in this one the window simply stops repainting, which is exactly the
 * freeze that was described.
 *
 * Gesture events arrive continuously and carry data from a separate Python
 * process, so they are the most likely source of such a throw. Treating them as
 * best-effort input - log, drop the frame, keep running - is correct: the next
 * frame arrives 33 ms later and carries the current truth anyway.
 */
process.on('uncaughtException', (error) => {
  log.error('crash', 'Uncaught exception (app kept alive).', error);
});
process.on('unhandledRejection', (reason) => {
  log.error('crash', 'Unhandled promise rejection (app kept alive).', reason);
});
process.on('warning', (warning) => {
  log.warn('node', `${warning.name}: ${warning.message}`);
});

// Chromium can lose a GPU or utility process without touching the renderer. The
// window keeps running but video and capture can stop, which is the other way
// this app can appear to freeze.
app.on('child-process-gone', (_event, details) => {
  log.error('app', `Child process gone: ${details.type} — ${details.reason} (exit ${details.exitCode}).`);
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  configurePermissions();
  log.info('app', 'Ready.', { logFile: logFile() });

  const settings = new Settings(app.getPath('userData'));
  client = new OrbitClient(settings);
  gestures = new GestureBridge(repoRoot);
  const pointer = new SystemPointer(join(app.getPath('userData'), 'orbit', 'pointer-agent.ps1'));
  systemPointer = pointer;

  registerIpc({ client, settings, getWindow: () => mainWindow, desktopCapturer, gestures, systemPointer: pointer });

  createWindow();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

app.on('window-all-closed', () => {
  log.info('app', 'All windows closed.');
  client?.dispose();
  gestures?.stop();
  systemPointer?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

// The Python service is a child process; never leave the camera running.
app.on('before-quit', () => {
  log.info('app', 'Quitting.');
  carryIndicator().destroy();
  client?.dispose();
  gestures?.stop();
  systemPointer?.dispose();
});
