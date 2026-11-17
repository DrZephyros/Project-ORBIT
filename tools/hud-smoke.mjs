/**
 * Smoke test for the left-hand overlay, without a hand.
 *
 *   npx electron tools/hud-smoke.mjs
 *
 * Creates the real overlay through the real code path and asks it what it is
 * displaying. The overlay is only ever created by a closed left hand, so without
 * this its page could be broken and nothing would say so until the user tried the
 * gesture. Development only.
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

// Electron on Windows is a GUI subsystem binary: nothing it writes to stdout
// reaches the console that started it. Results go to a file instead.
const REPORT = process.env.ORBIT_HUD_REPORT || 'hud-smoke.json';
const report = (data) => writeFileSync(REPORT, JSON.stringify(data, null, 2));

const { gestureHud } = await import('../packages/desktop/dist/main/gesture-hud.js');

await app.whenReady();
const hud = gestureHud();
hud.leftHand(true, 0.45);
await new Promise((r) => setTimeout(r, 1200));

const wins = BrowserWindow.getAllWindows();
const lines = [];
const say = (...args) => lines.push(args.join(' '));
say('overlay windows:', wins.length);
if (wins.length === 0) {
  say('FAIL: no overlay was created');
  report({ ok: false, lines });
  app.exit(1);
} else {
  const win = wins[wins.length - 1];
  const state = await win.webContents.executeJavaScript(
    `({ label: document.getElementById('label').textContent,
        sub: document.getElementById('sub').textContent,
        width: document.getElementById('fill').style.width,
        cls: document.getElementById('root').className })`,
  );
  say('slide state:', JSON.stringify(state));
  win.webContents.executeJavaScript(`hud.flash('DESKTOP LEFT', 'left fist')`).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const flashed = await win.webContents.executeJavaScript(
    `({ label: document.getElementById('label').textContent, cls: document.getElementById('root').className })`,
  );
  say('flash state:', JSON.stringify(flashed));
  const ok = flashed.label === 'DESKTOP LEFT' && flashed.cls.includes('flash');
  say(ok ? 'PASS' : 'FAIL');
  report({ ok, lines, state, flashed });
  app.exit(ok ? 0 : 1);
}
