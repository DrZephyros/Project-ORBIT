#!/usr/bin/env node
/**
 * Desktop dev orchestrator.
 *
 * Replaces a single `concurrently` line so the renderer port can be chosen at
 * runtime. The launcher picks a free port and passes it as ORBIT_RENDERER_PORT;
 * Vite and Electron both read it, so they cannot disagree.
 *
 * If Vite still cannot bind (something grabbed the port in between), we move to
 * the next port instead of exiting. Losing the whole app to a port clash is the
 * failure this file exists to prevent.
 *
 * A Node script rather than shell syntax: `${VAR:-default}` does not exist in
 * cmd.exe, and this has to behave the same on Windows and POSIX.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const pkgDir = resolve(here, '..');
const electronBin = join(pkgDir, '..', '..', 'node_modules', '.bin', 'electron');
const electronTarget = existsSync(electronBin) ? electronBin : 'electron';

const START_PORT = Number(process.env.ORBIT_RENDERER_PORT ?? 5173);
const MAX_PORT_TRIES = 10;

/**
 * True when a port cannot be bound on either address family.
 *
 * This is the check that actually matters on Windows: a foreign server bound to
 * 0.0.0.0 (IPv4) does not stop Vite binding [::1] (IPv6), so --strictPort is
 * happy while two servers share "port 5173" and requests go somewhere random.
 * Vite reporting "ready" is therefore not proof the port was ours.
 */
function portBusy(port) {
  return new Promise((done) => {
    const probe = (hosts) => {
      if (hosts.length === 0) return done(false);
      const [host, ...rest] = hosts;
      const server = net.createServer();
      server.once('error', () => done(true));
      server.once('listening', () => server.close(() => probe(rest)));
      try {
        server.listen({ port, host, exclusive: true, ipv6Only: false });
      } catch {
        done(true);
      }
    };
    probe(['0.0.0.0', '::']);
  });
}

const children = [];
let shuttingDown = false;

function track(label, child) {
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stderr.write(`\n[dev] ${label} exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. Compile the main process continuously.
const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.main.json', '--watch'], {
  cwd: pkgDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: process.env,
});
tsc.stdout.on('data', (c) => process.stdout.write(c));
tsc.stderr.on('data', (c) => process.stderr.write(c));
track('tsc', tsc);

// 2./3. Vite, then Electron once it is listening.
let port = START_PORT;
let tries = 0;
let vite = null;
let started = false;

function startVite() {
  if (vite) {
    try {
      vite.kill();
    } catch {
      /* already gone */
    }
  }

  // Verify the port is genuinely free before handing it to Vite. Vite would
  // happily bind the other address family and report success, which is exactly
  // how a foreign server on 5173 used to produce a half-working app.
  void portBusy(port).then((busy) => {
    if (shuttingDown) return;
    if (busy) {
      process.stderr.write(`[dev] port ${port} is already in use on this machine\n`);
      nextPort();
      return;
    }
    spawnVite();
  });
}

function spawnVite() {
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ORBIT_RENDERER_PORT: String(port) },
  });
  vite = child;
  children.push(child);

  let failedToBind = false;

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (/Port \d+ is already in use|EADDRINUSE/i.test(text) && !failedToBind) {
      failedToBind = true;
      nextPort();
    }
  });

  child.on('error', () => nextPort());

  // Vite prints "ready in" once it is actually serving.
  child.stdout.on('data', (chunk) => {
    if (/ready in/i.test(chunk.toString()) && !started) {
      started = true;
      launchElectron();
    }
  });
}

function nextPort() {
  if (shuttingDown) return;
  if (tries >= MAX_PORT_TRIES) {
    process.stderr.write(`[dev] no free renderer port after ${MAX_PORT_TRIES} tries\n`);
    shutdown(1);
    return;
  }
  tries += 1;
  port += 1;
  process.stderr.write(`[dev] renderer port busy, trying ${port}\n`);
  startVite();
}

function launchElectron() {
  const child = spawn(electronTarget, ['.'], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ORBIT_RENDERER_URL: `http://localhost:${port}` },
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  track('electron', child);
}

startVite();
