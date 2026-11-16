#!/usr/bin/env node
/**
 * ORBIT launcher.
 *
 * One command instead of three terminals. It:
 *   1. checks Node and the Python gesture dependencies,
 *   2. picks the Python interpreter that actually has MediaPipe installed
 *      (this machine has more than one), and exports ORBIT_PYTHON,
 *   3. builds anything stale (shared types, receiver, server, desktop main),
 *   4. frees ports left behind by a previous run,
 *   5. starts the signalling server and the Electron app together,
 *   6. shuts both down cleanly on Ctrl+C.
 *
 * Flags:
 *   --no-build     skip the build step (faster restarts)
 *   --no-server    skip the signalling server (gestures only)
 *   --check        run the preflight checks and exit
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = {
  build: !argv.includes('--no-build'),
  server: !argv.includes('--no-server'),
  checkOnly: argv.includes('--check'),
};

const SERVER_PORT = Number(process.env.ORBIT_PORT ?? 8787);
/** Plain-HTTP port: browser redirect plus the desktop app's loopback socket. */
const HTTP_PORT = Number(process.env.ORBIT_HTTP_PORT ?? 8788);
/**
 * Preferred port for the desktop renderer (Vite).
 *
 * This used to be a hard requirement: if 5173 was taken the launcher killed the
 * owner and, failing that, exited — so a stray dev server could stop the whole
 * app. The port is now a *preference*: `pickRendererPort()` walks a range and the
 * chosen port is passed to Vite and Electron through the environment.
 */
const RENDERER_PORT_PREFERRED = Number(process.env.ORBIT_RENDERER_PORT ?? 5173);
/** How far past the preferred port to search before giving up. */
const RENDERER_PORT_SPAN = 20;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;
const paint = (code) => (text) => (isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const bold = paint('1');

const step = (label) => process.stdout.write(`${dim('>')} ${label} `);
const done = (msg = 'ok') => process.stdout.write(`${green(msg)}\n`);
const note = (msg) => process.stdout.write(`${dim(msg)}\n`);
const warn = (msg) => process.stdout.write(`${yellow(msg)}\n`);
const fail = (msg) => process.stdout.write(`${red(msg)}\n`);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    // No shell: on Windows, `shell: true` concatenates arguments without
    // escaping, which mangles the `-c` Python one-liners we rely on to probe
    // dependencies. Node resolves `python` from PATH by itself.
    shell: false,
    ...opts,
  });
}

/**
 * True if a TCP port cannot be bound on localhost.
 *
 * We test bindability rather than connectability: a socket left in TIME_WAIT or
 * FIN_WAIT still accepts connections, which makes a healthy port look busy and
 * blocks startup for no reason. If we can bind it, it is free for us.
 */
async function portInUse(port) {
  // The signalling server binds 0.0.0.0 while Vite prefers IPv6, so check both
  // families. Either one being taken means we cannot start cleanly.
  const hosts = ['0.0.0.0', '::'];
  for (const host of hosts) {
    const busy = await new Promise((resolvePort) => {
      const server = net.createServer();
      server.once('error', () => resolvePort(true));
      server.once('listening', () => server.close(() => resolvePort(false)));
      try {
        server.listen({ port, host, exclusive: true, ipv6Only: false });
      } catch {
        // Address family unsupported on this machine; nothing to check.
        resolvePort(false);
      }
    });
    if (busy) return true;
  }
  return false;
}

/**
 * Free a port held by a previous ORBIT run.
 *
 * This is the recovery the user used to have to do by hand: a leftover Vite on
 * 5173 makes every later launch fail with "Port 5173 is already in use".
 * We only kill the process that owns the port, and only after saying so.
 */
/** PIDs of processes holding a port (Windows).
 *
 * Uses Get-NetTCPConnection, not netstat: netstat sometimes omits a socket that
 * is still held (a process can own 0.0.0.0:PORT while no netstat row appears),
 * which made the launcher report "did not become available" with no way to
 * recover. netstat is kept as a fallback for older systems.
 */
function listeningPids(port) {
  const pids = new Set();

  const ps = run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess`,
  ]);
  for (const line of (ps.stdout ?? '').split(/\r?\n/)) {
    const pid = line.trim();
    if (pid && pid !== '0' && /^\d+$/.test(pid)) pids.add(pid);
  }

  if (pids.size === 0) {
    const out = run('netstat', ['-ano']);
    for (const line of (out.stdout ?? '').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const local = parts[1] ?? '';
      if (!local.endsWith(`:${port}`)) continue;
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && /^\d+$/.test(pid)) pids.add(pid);
    }
  }

  return pids;
}

async function freePort(port, label) {
  if (!(await portInUse(port))) return true;

  // Only report a leftover process when one is actually listening. A port that
  // merely accepts on a dying FIN_WAIT socket needs no action; it clears itself.
  const pids = process.platform === 'win32' ? listeningPids(port) : new Set();

  if (pids.size > 0) {
    warn(`port ${port} (${label}) is held by a previous run`);
    for (const pid of pids) {
      run('taskkill', ['/F', '/PID', pid]);
      note(`  stopped leftover process ${pid}`);
    }
  } else if (process.platform !== 'win32') {
    warn(`port ${port} (${label}) is held by a previous run`);
    run('sh', ['-lc', `lsof -ti tcp:${port} | xargs -r kill -9`]);
  }

  // Wait for the OS to release the socket. A lingering FIN_WAIT only needs a
  // few seconds, so give it a real window rather than failing instantly.
  for (let i = 0; i < 40; i += 1) {
    if (!(await portInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (pids.size === 0) {
    fail(`port ${port} did not become available`);
    note('  A socket from a previous run is still closing. Wait a few seconds and retry.');
  }
  return false;
}

function modifiedTime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Choose a port for the desktop renderer.
 *
 * Returns the preferred port when free, otherwise the next free one in range.
 * This replaces "free 5173 or exit": the app must not refuse to start because
 * some other dev server happens to sit on 5173.
 */
async function pickRendererPort(from = RENDERER_PORT_PREFERRED) {
  for (let candidate = from; candidate <= RENDERER_PORT_PREFERRED + RENDERER_PORT_SPAN; candidate += 1) {
    if (!(await portInUse(candidate))) return candidate;
  }
  return null;
}
/**
 * Newest modification time anywhere under a directory.
 *
 * The staleness check used to name four specific files, so editing anything
 * else (tls.ts, link.ts, a component) left the launcher running old bundles and
 * the shortcut behaved differently from `npm run build`. Walking the trees
 * means a new file can never be missed.
 */
function newestIn(dir, extensions = ['.ts', '.tsx', '.css', '.html']) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Build output and dependencies never count as source.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      newest = Math.max(newest, newestIn(full, extensions));
      continue;
    }
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
    newest = Math.max(newest, modifiedTime(full));
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    fail(`Node ${process.versions.node} is too old`);
    note('  ORBIT needs Node 20 or newer.');
    return false;
  }
  done(`Node ${process.versions.node}`);
  return true;
}

function checkInstalled() {
  if (!existsSync(join(root, 'node_modules'))) {
    fail('dependencies missing');
    note('  Run: npm install');
    return false;
  }
  done();
  return true;
}

/**
 * Warn when Windows blocks the LAN port.
 *
 * The iPad cannot reach the receiver until an inbound rule exists, and adding
 * one needs elevation, so this reports the exact command instead of failing
 * silently at "the site won't load" time.
 */
function checkFirewall(port) {
  if (process.platform !== 'win32') return true;
  let out = '';
  try {
    out = execFileSync(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    // netsh unavailable or blocked: not worth blocking startup over.
    return true;
  }
  if (out.includes(String(port))) {
    done(`firewall rule for port ${port}`);
    return true;
  }
  fail(`no inbound firewall rule for port ${port}`);
  note('  The iPad will not load the receiver until this is allowed once.');
  note('  Run this in an Administrator terminal:');
  note(
    `    netsh advfirewall firewall add rule name="ORBIT ${port}" dir=in action=allow protocol=TCP localport=${port} profile=private`,
  );
  return true; // Warning only: the desktop app still works on this machine.
}

/**
 * Find a Python that can actually import mediapipe, cv2 and websockets.
 *
 * Taking the first `python` on PATH is not enough: this machine has Python 3.10
 * (with the packages) and 3.13 (without), and the order is not guaranteed.
 */
function findPython() {
  // An explicit override wins: if the user set ORBIT_PYTHON we test only that,
  // so a typo surfaces immediately instead of silently using another Python.
  const explicit = process.env.ORBIT_PYTHON;
  const candidates = [
    explicit,
    'python',
    'python3',
    'py',
    'C:\\Program Files\\Python310\\python.exe',
  ].filter(Boolean);

  const probe = 'import mediapipe, cv2, websockets';
  const tried = [];

  for (const candidate of candidates) {
    if (explicit && candidate !== explicit) break;
    const result = run(candidate, ['-c', probe], { stdio: 'ignore' });
    tried.push(candidate);
    if (result.status === 0) {
      const version = run(candidate, ['-c', 'import sys;print(".".join(map(str,sys.version_info[:2])))']);
      return { path: candidate, version: (version.stdout ?? '').trim() || '?', tried, explicit: Boolean(explicit) };
    }
  }
  return { path: null, version: null, tried, explicit: Boolean(explicit) };
}

function checkPython() {
  const found = findPython();
  if (found.path) {
    done(`Python ${found.version} with camera dependencies`);
    // Pin the interpreter so the Electron app uses the same one we verified.
    process.env.ORBIT_PYTHON = found.path;
    return true;
  }

  fail('gesture dependencies missing');
  note('');
  if (found.explicit) {
    note('  ORBIT_PYTHON is set but that interpreter cannot import the packages.');
    note(`  Check: ${found.tried.join(', ')}`);
  } else {
    note('  Gesture recognition needs three Python packages.');
    note('  Install them with:');
    note('');
    note('      pip install mediapipe opencv-python websockets');
    note('');
    note(`  Tried: ${found.tried.join(', ')}`);
  }
  note('  ORBIT will still start, but the camera will be unavailable.');
  note('');
  return false;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function needsBuild() {
  const sharedDist = join(root, 'packages/shared/dist/index.js');
  const serverDist = join(root, 'packages/server/dist/index.js');
  const receiverDist = join(root, 'packages/receiver/dist/index.html');
  const desktopMain = join(root, 'packages/desktop/dist/main/main.js');
  const desktopUi = join(root, 'packages/desktop/dist/renderer/index.html');

  for (const artifact of [sharedDist, serverDist, receiverDist, desktopMain, desktopUi]) {
    if (!existsSync(artifact)) return `missing ${artifact.replace(root + '\\', '').replace(root + '/', '')}`;
  }

  // If any source is newer than the build output, rebuild. Scan the whole src
  // tree of each package so no file is left out of the check.
  const newestSource = Math.max(
    newestIn(join(root, 'packages/shared/src')),
    newestIn(join(root, 'packages/server/src')),
    newestIn(join(root, 'packages/desktop/src')),
    newestIn(join(root, 'packages/receiver/src')),
    modifiedTime(join(root, 'packages/receiver/index.html')),
  );
  const oldestArtifact = Math.min(
    modifiedTime(sharedDist),
    modifiedTime(serverDist),
    modifiedTime(desktopMain),
    modifiedTime(desktopUi),
  );
  if (newestSource > oldestArtifact) return 'sources changed';
  return null;
}

function build() {
  const reason = needsBuild();
  if (!reason) {
    done('up to date');
    return true;
  }

  note(`(${reason})`);
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Suppress Node's warning about using a shell; `npm` is a .cmd on Windows
    // and needs one, and we pass no user-controlled arguments here.
    env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
  });
  if (result.status !== 0) {
    fail('build failed');
    note('  Fix the errors above, then run again.');
    return false;
  }
  done('built');
  return true;
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

const LOCK_PORT = 8799;
let lockServer = null;

/**
 * Claim a lock so only one ORBIT runs at a time.
 *
 * Ports are how we detect a running instance: if 8799 is taken, another ORBIT
 * already owns the workspace. This is deliberately a plain TCP bind, so a
 * crashed instance never leaves a stale lock file behind.
 */
function claimSingleInstance() {
  return new Promise((resolveLock) => {
    const server = net.createServer();
    server.once('error', () => resolveLock(false));
    server.once('listening', () => {
      lockServer = server;
      resolveLock(true);
    });
    server.listen({ port: LOCK_PORT, host: '127.0.0.1', exclusive: true });
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\n');
  note('  Stopping ORBIT…');

  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree. `/T` walks children of the given PID, but once a
        // wrapper such as `npm` has exited its own tree is already detached, so
        // we also kill whatever still owns our ports below.
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
          env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }

  // Belt and braces: anything still holding our ports is an orphan from this
  // run (Electron, Vite, the gesture service), so stop it by PID.
  if (process.platform === 'win32') {
    for (const port of [SERVER_PORT, HTTP_PORT, RENDERER_PORT_PREFERRED]) {
      for (const pid of listeningPids(port)) {
        spawnSync('taskkill', ['/F', '/T', '/PID', pid], {
          stdio: 'ignore',
          env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
        });
      }
    }
  }

  releaseLock();
  process.exit(code);
}

function releaseLock() {
  if (lockServer) {
    try {
      lockServer.close();
    } catch {
      /* shutting down anyway */
    }
    lockServer = null;
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  process.stdout.write(`\n  ${bold('ORBIT')} ${dim('— starting')}\n\n`);

  // One ORBIT at a time. Otherwise a second launch steals the ports from a
  // session that is already running and the first window dies silently.
  if (!(await claimSingleInstance())) {
    note('  ORBIT is already running.');
    note('  Use the existing window, or close it and start again.');
    process.stdout.write('\n');
    process.exit(1);
  }

  step('Checking Node');
  if (!checkNode()) process.exit(1);

  step('Checking project dependencies');
  if (!checkInstalled()) process.exit(1);

  if (!flags.noServer) {
    step('Checking LAN access for the iPad');
    checkFirewall(SERVER_PORT);
    // Plain-HTTP requests are redirected on this port, so it must be reachable
    // too, otherwise a bare http:// address still times out.
    checkFirewall(HTTP_PORT);
  }

  step('Checking camera support');
  const hasPython = checkPython();

  if (flags.checkOnly) {
    process.stdout.write(`\n  ${dim('Preflight complete.')}\n\n`);
    process.exit(hasPython ? 0 : 0);
  }

  if (flags.build) {
    step('Preparing build');
    if (!build()) process.exit(1);
  }

  // Free ports before binding, so a crashed previous run cannot block startup.
  // The plain-HTTP port matters as much as the TLS one: the desktop's signalling
  // socket lives there, and an orphan still holding it would put the desktop on
  // an old hub while the iPad joined a new one (which looks like "cannot reach
  // the laptop" plus pairing codes that never match).
  if (flags.server) {
    for (const [port, label] of [
      [SERVER_PORT, 'signalling server'],
      [HTTP_PORT, 'plain HTTP / desktop socket'],
    ]) {
      step(`Freeing port ${port}`);
      if (await freePort(port, label)) done();
      else {
        fail('could not free the port');
        note(`  Something is still using ${port}. Close it and try again.`);
        process.exit(1);
      }
    }
  }

  // The renderer port is a preference, not a requirement. Clear a leftover ORBIT
  // dev server, but if the port is still held by something else just move to the
  // next free one instead of refusing to start.
  step(`Choosing the desktop UI port`);
  // Deliberately do NOT reclaim this port by killing its owner. 5173 is a
  // conventional dev-server port, so the holder is very likely someone else's
  // Vite, and killing it to make room would be rude and surprising. The picker
  // simply moves to the next free port instead.
  const rendererPort = await pickRendererPort();
  if (rendererPort === null) {
    fail('no free port');
    note(
      `  No free port in ${RENDERER_PORT_PREFERRED}-${RENDERER_PORT_PREFERRED + RENDERER_PORT_SPAN}. ` +
        'Close other dev servers and try again.',
    );
    process.exit(1);
  }
  if (rendererPort !== RENDERER_PORT_PREFERRED) {
    done(`${rendererPort}`);
    note(`  ${RENDERER_PORT_PREFERRED} is in use by something else; using ${rendererPort} instead.`);
  } else {
    done(`${rendererPort}`);
  }

  process.stdout.write('\n');

  if (flags.server) {
    const server = spawn('npm', ['run', 'dev:server'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });
    children.push(server);
    server.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      // Surface only the useful lines, not npm's banner noise.
      for (const line of text.split('\n')) {
        if (/local\s*:|ipad\s*:|error/i.test(line)) note(`  [server] ${line.trim()}`);
      }
    });
    server.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) fail(`  [server] ${text}`);
    });
  }

  const desktop = spawn('npm', ['run', 'dev:desktop'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      NODE_OPTIONS: '--no-warnings',
      // Point the app at the plain loopback signalling port. Without this it
      // defaulted to the HTTPS port and the socket was refused outright.
      ORBIT_SERVER: `ws://127.0.0.1:${HTTP_PORT}/ws`,
      // The renderer port is chosen at runtime, so Vite and Electron must both be
      // told about it rather than assuming 5173.
      ORBIT_RENDERER_PORT: String(rendererPort),
      ORBIT_RENDERER_URL: `http://localhost:${rendererPort}`,
    },
  });
  children.push(desktop);

  let readyAnnounced = false;
  let desktopLog = '';
  desktop.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    desktopLog += text;
    if (desktopLog.length > 20000) desktopLog = desktopLog.slice(-20000);
    if (!readyAnnounced && /ready in/i.test(text)) {
      readyAnnounced = true;
      process.stdout.write(`  ${green('ORBIT is running.')}\n`);
      note('  Connect your iPad with the pairing code; the session and camera start by themselves.');
      note('  Press Ctrl+C here to stop everything.');
      process.stdout.write('\n');
    }
  });
  desktop.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    desktopLog += text;
    if (desktopLog.length > 20000) desktopLog = desktopLog.slice(-20000);
    // Electron's cache warnings are noise on Windows; everything else matters.
    for (const line of text.split('\n')) {
      const clean = line.trim();
      if (!clean) continue;
      if (/cache_util_win|disk_cache|gpu_disk_cache|gpu_process_host|network_service_instance/i.test(clean)) continue;
      if (/\[electron\]/i.test(clean)) fail(`  ${clean}`);
    }
  });

  desktop.on('exit', (code) => {
    if (!shuttingDown) {
      if (code !== 0) {
        process.stdout.write('\n');
        fail(`  The desktop app exited with code ${code}.`);
        // 0xC000013A is STATUS_CONTROL_C_EXIT: the console ORBIT was started
        // from received Ctrl+C, or its window was closed. Nothing crashed — the
        // app was killed with its console. Worth naming, because "exited with
        // code 3221225786" reads like a bug in the app and sends everyone
        // looking in the wrong place.
        if (code === 3221225786 || code === -1073741510) {
          note('  The ORBIT console was closed or Ctrl+C was pressed; the app stops with it.');
          note('  Start ORBIT again and leave its window open while you use it.');
        } else if (/Port \d+ is already in use|EADDRINUSE/i.test(desktopLog)) {
          note('  Another process took the renderer port after startup began.');
          note('  Close the other ORBIT window and run again.');
        } else {
          note('  Scroll up for the first error.');
        }
      }
      shutdown(code ?? 0);
    }
  });

  if (!hasPython) {
    note('  Note: the camera will not start until the Python packages are installed.');
    process.stdout.write('\n');
  }

  if (!flags.server) {
    note('  Running without the signalling server — the iPad receiver is unavailable.');
  }
}

main().catch((error) => {
  process.stdout.write('\n');
  fail(`  Launcher failed: ${error.message}`);
  shutdown(1);
});
