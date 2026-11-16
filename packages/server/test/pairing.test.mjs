/**
 * End-to-end protocol smoke test.
 *
 * Boots the real server, connects a fake desktop and a fake receiver over the
 * real WebSocket protocol, and asserts the whole Stage 1 flow:
 * pairing -> welcome -> sources -> offer/answer relay -> workspace echo ->
 * wrong code rejected -> code burned after use -> revoke drops the receiver.
 *
 * Run with: node packages/server/test/pairing.test.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8899;
const BASE = `127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    failed += 1;
  }
}

/** Minimal client that queues messages so tests can await specific ones. */
class Client {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('socket error'));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    };
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  next(timeout = 3000) {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeout);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async until(predicate, timeout = 3000) {
    const deadline = Date.now() + timeout;
    const seen = [];
    while (Date.now() < deadline) {
      const msg = await this.next(Math.max(50, deadline - Date.now()));
      seen.push(msg.t);
      if (predicate(msg)) return msg;
    }
    throw new Error(`never saw expected message. saw: ${seen.join(', ')}`);
  }

  close() {
    this.ws.close();
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  throw new Error('server did not start');
}

const serverDir = join(__dirname, '..');
const proc = spawn(process.execPath, [join(serverDir, 'dist', 'index.js')], {
  cwd: serverDir,
  // The harness speaks plain HTTP/WS, so the server must not generate TLS
  // here. In real use the desktop goes through the loopback HTTP port and the
  // iPad through HTTPS; this test is protocol-only.
  env: { ...process.env, ORBIT_PORT: String(PORT), ORBIT_BIND: '127.0.0.1', ORBIT_NO_TLS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
proc.stdout.on('data', (d) => {
  serverOutput += d.toString();
});
proc.stderr.on('data', (d) => {
  serverOutput += d.toString();
});

try {
  await waitForServer();

  await test('health endpoint responds', async () => {
    const res = await fetch(`http://${BASE}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  let desktop = new Client(`ws://${BASE}/ws`);
  await desktop.open;

  let code;
  let currentCode;
  let sessionId;

  await test('desktop hello returns a welcome with a 6-digit pairing code', async () => {
    desktop.send({
      t: 'desktop.hello',
      device: { id: 'desk-1', role: 'desktop', name: 'Test laptop', kind: 'browser' },
    });
    const welcome = await desktop.next();
    assert.equal(welcome.t, 'server.welcome');
    assert.equal(welcome.protocol, 1);
    assert.ok(welcome.pairing, 'pairing offer present');
    assert.match(welcome.pairing.code, /^\d{6}$/);
    assert.match(welcome.pairing.url, /^http:\/\/.+:\d+\/r$/);
    code = welcome.pairing.code;
    sessionId = welcome.session.id;
  });

  await test('receiver with a wrong code is rejected', async () => {
    const wrong = new Client(`ws://${BASE}/ws`);
    await wrong.open;
    const bad = code === '000000' ? '111111' : '000000';
    wrong.send({
      t: 'receiver.hello',
      device: { id: 'r-bad', role: 'receiver', name: 'iPad', kind: 'ipad' },
      code: bad,
    });
    const res = await wrong.until((m) => m.t === 'server.error' || m.t === 'server.welcome');
    assert.equal(res.t, 'server.error', 'must not be welcomed');
    assert.equal(res.code, 'bad-code');
    wrong.close();
  });

  let receiver = new Client(`ws://${BASE}/ws`);
  await receiver.open;

  await test('receiver with the correct code joins and both sides learn about it', async () => {
    receiver.send({
      t: 'receiver.hello',
      device: { id: 'r-good', role: 'receiver', name: 'iPad Pro', kind: 'ipad' },
      code,
    });
    const welcome = await receiver.next();
    assert.equal(welcome.t, 'server.welcome');
    assert.equal(welcome.session.phase, 'live');

    const joined = await desktop.until((m) => m.t === 'server.receiver.joined');
    assert.equal(joined.receiver.name, 'iPad Pro');
    assert.equal(joined.receiver.kind, 'ipad');

    // Joining rotates the code; remember the live one for the reconnect test.
    const rotated = await desktop.until((m) => m.t === 'server.pairing');
    currentCode = rotated.pairing.code;
  });

  await test('pairing code is burned after a successful join', async () => {
    const replay = new Client(`ws://${BASE}/ws`);
    await replay.open;
    replay.send({
      t: 'receiver.hello',
      device: { id: 'r-replay', role: 'receiver', name: 'iPad', kind: 'ipad' },
      code,
    });
    const res = await replay.until((m) => m.t === 'server.error' || m.t === 'server.welcome');
    assert.equal(res.t, 'server.error', 'reusing the code must fail');
    replay.close();
  });

  await test('desktop sources reach the receiver', async () => {
    desktop.send({
      t: 'desktop.sources',
      sources: {
        sources: [{ id: 'window:1', name: 'Notepad', native: false }],
        activeSourceId: 'window:1',
      },
    });
    const got = await receiver.until((m) => m.t === 'server.sources');
    assert.equal(got.sources.sources[0].name, 'Notepad');
    assert.equal(got.sources.activeSourceId, 'window:1');
  });

  await test('offer and answer are relayed across the pair', async () => {
    desktop.send({ t: 'desktop.offer', panelId: 'p1', offer: { kind: 'offer', sdp: 'v=0 fake-offer' } });
    const offer = await receiver.until((m) => m.t === 'server.offer');
    assert.equal(offer.panelId, 'p1');
    assert.equal(offer.offer.sdp, 'v=0 fake-offer');

    receiver.send({ t: 'receiver.answer', panelId: 'p1', req: { kind: 'answer', sdp: 'v=0 fake-answer' } });
    const answer = await desktop.until((m) => m.t === 'server.answer');
    assert.equal(answer.panelId, 'p1');
    assert.equal(answer.req.sdp, 'v=0 fake-answer');
  });

  await test('ICE candidates flow in both directions', async () => {
    desktop.send({
      t: 'desktop.ice',
      panelId: 'p1',
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const incoming = await receiver.until((m) => m.t === 'server.ice');
    assert.equal(incoming.panelId, 'p1');

    receiver.send({
      t: 'receiver.ice',
      panelId: 'p1',
      candidate: { candidate: 'candidate:2 1 udp 1 127.0.0.1 5001 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const outbound = await desktop.until((m) => m.t === 'server.ice');
    assert.equal(outbound.panelId, 'p1');
  });

  await test('hand pointer and pinch click are relayed to receivers', async () => {
    const pointer = { x: 0.4, y: 0.6, visible: true, target: 'tablet' };
    desktop.send({ t: 'desktop.pointer', pointer });
    const moved = await receiver.until((m) => m.t === 'server.pointer');
    assert.deepEqual(moved.pointer, pointer);

    desktop.send({ t: 'desktop.pointer.click', pointer });
    const clicked = await receiver.until((m) => m.t === 'server.pointer.click');
    assert.deepEqual(clicked.pointer, pointer);
  });

  await test('receiver panel actions reach the desktop as typed envelopes', async () => {
    receiver.send({ t: 'receiver.panel.move', panelId: 'p1', rect: { x: 10, y: 20, width: 300, height: 200 } });
    const moved = await desktop.until((m) => m.t === 'server.panel.move');
    assert.deepEqual(moved.rect, { x: 10, y: 20, width: 300, height: 200 });

    receiver.send({ t: 'receiver.panel.return', panelId: 'p1' });
    const returned = await desktop.until((m) => m.t === 'server.panel.return');
    assert.equal(returned.panelId, 'p1');

    receiver.send({ t: 'receiver.mode.set', mode: 'interact' });
    const mode = await desktop.until((m) => m.t === 'server.mode.set');
    assert.equal(mode.mode, 'interact');

    receiver.send({ t: 'receiver.stop' });
    const stopped = await desktop.until((m) => m.t === 'server.stop');
    assert.equal(stopped.t, 'server.stop');
  });

  await test('the iPad pointing at a transferred window reaches the desktop', async () => {
    // The cursor, the button and the keyboard for a window sent to the iPad all
    // travel this way: a small typed message, never a frame. The server only
    // relays, but a typo in a message name would silently do nothing at all, so
    // the whole path is asserted here.
    receiver.send({ t: 'receiver.remote.pointer', panelId: 'p9', x: 0.5, y: 0.25, kind: 'move', at: 1 });
    const moved = await desktop.until((m) => m.t === 'server.remote.pointer');
    assert.equal(moved.panelId, 'p9');
    assert.equal(moved.kind, 'move');
    assert.equal(moved.x, 0.5);
    assert.equal(moved.y, 0.25);

    receiver.send({ t: 'receiver.remote.key', panelId: 'p9', text: 'hi', at: 2 });
    const typed = await desktop.until((m) => m.t === 'server.remote.key');
    assert.equal(typed.text, 'hi');
    assert.equal(typed.key, undefined);

    receiver.send({ t: 'receiver.remote.key', panelId: 'p9', key: 'Enter', at: 3 });
    const keyed = await desktop.until((m) => m.t === 'server.remote.key' && m.key === 'Enter');
    assert.equal(keyed.panelId, 'p9');
  });

  await test('a position outside the window is clamped, not dropped', async () => {
    // A tracker that reports a hand slightly off the edge of the frame must not
    // be able to click outside the window it is meant to be controlling.
    receiver.send({ t: 'receiver.remote.pointer', panelId: 'p9', x: -3, y: 40, kind: 'down', at: 4 });
    const down = await desktop.until((m) => m.t === 'server.remote.pointer' && m.kind === 'down');
    assert.equal(down.x, 0);
    assert.equal(down.y, 1);
  });

  await test('malformed and unknown messages do not kill the connection', async () => {
    receiver.ws.send('{not json');
    const err = await receiver.until((m) => m.t === 'server.error');
    assert.equal(err.code, 'protocol');

    receiver.send({ t: 'totally.unknown' });
    const err2 = await receiver.until((m) => m.t === 'server.error');
    assert.equal(err2.code, 'protocol');

    // Still alive afterwards.
    receiver.send({ t: 'receiver.ping', at: 42 });
    const pong = await receiver.until((m) => m.t === 'server.pong');
    assert.equal(pong.at, 42);
  });

  await test('a paired receiver resumes without a burned pairing code', async () => {
    receiver.close();
    // Wait for the server to register the drop, then reconnect as the same
    // device. This is the iPad-reload / Wi-Fi-blip path: there is no code left
    // to send, only the identity in local storage.
    await desktop.until((m) => m.t === 'server.receiver.left');
    const resumed = new Client(`ws://${BASE}/ws`);
    await resumed.open;
    resumed.send({
      t: 'receiver.hello',
      device: { id: 'r-good', role: 'receiver', name: 'iPad Pro', kind: 'ipad' },
      code: '',
    });
    const welcome = await resumed.next();
    assert.equal(welcome.t, 'server.welcome');
    assert.equal(welcome.session.receivers.length, 1, 'resume must not duplicate the device');
    receiver = resumed;
  });

  await test('a desktop reconnect keeps the session and pairing code', async () => {
    desktop.close();
    const reconnected = new Client(`ws://${BASE}/ws`);
    await reconnected.open;
    reconnected.send({
      t: 'desktop.hello',
      device: { id: 'desk-1', role: 'desktop', name: 'Test laptop', kind: 'browser' },
    });
    const welcome = await reconnected.next();
    assert.equal(welcome.t, 'server.welcome');
    assert.equal(welcome.session.id, sessionId, 'the session must be reused, not replaced');
    assert.equal(welcome.pairing.code, currentCode, 'the live QR code must not be rotated away');
    assert.equal(welcome.session.receivers.length, 1, 'the paired iPad stays attached');
    desktop = reconnected;
  });

  await test('the desktop can ask for a replacement code when one expires', async () => {
    // Reported: "when a code expires there is no way to get a new one." A code
    // lives five minutes and is single use, and the server only ever pushed one
    // on its own initiative, so the Setup page counted down to 0:00 and stopped
    // there. This is the request the new "New code" button sends.
    const expired = currentCode;
    desktop.send({ t: 'desktop.pairing.request' });
    const pairing = await desktop.until((m) => m.t === 'server.pairing');
    const fresh = pairing.pairing.code;
    assert.match(fresh, /^\d{6}$/, 'replacement is a six digit code');
    assert.notEqual(fresh, expired, 'the replacement must differ from the dead one');
    assert.ok(pairing.pairing.expiresAt > Date.now(), 'the replacement must still be live');
    assert.match(pairing.pairing.qrPayload, new RegExp(`#c=${fresh}$`), 'the QR carries the new code');

    // And the old code is genuinely dead, so a stale QR fails rather than
    // silently pairing with the wrong session.
    const stale = new Client(`ws://${BASE}/ws`);
    await stale.open;
    stale.send({
      t: 'receiver.hello',
      device: { id: 'r-stale', role: 'receiver', name: 'Old QR', kind: 'ipad' },
      code: expired,
    });
    const rejected = await stale.until((m) => m.t === 'server.error' || m.t === 'server.welcome');
    assert.equal(rejected.t, 'server.error', 'the expired code must not pair');
    stale.close();

    currentCode = fresh;
  });

  await test('revoking a receiver closes its socket and notifies the desktop', async () => {
    desktop.send({ t: 'desktop.device.revoke', receiverId: 'r-good' });
    const err = await receiver.until((m) => m.t === 'server.error');
    assert.equal(err.code, 'revoked');
    const left = await desktop.until((m) => m.t === 'server.receiver.left');
    assert.equal(left.receiverId, 'r-good');
  });

  await test('ending the session notifies the desktop and clears the code', async () => {
    desktop.send({ t: 'desktop.session.stop' });
    const session = await desktop.until((m) => m.t === 'server.session' && m.session.phase === 'ended');
    assert.equal(session.session.phase, 'ended');
  });

  desktop.close();
  receiver.close();
} catch (error) {
  console.error('setup failed:', error.message);
  console.error(serverOutput);
  failed += 1;
} finally {
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
