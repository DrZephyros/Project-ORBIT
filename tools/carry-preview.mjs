/**
 * Visual harness for the carry indicator.
 *
 *   npx electron tools/carry-preview.mjs
 *
 * Opens a mock "grabbed" window, puts the real carry overlay on it, captures the
 * screen at each state and writes PNGs to tools/out/. Development only - not part
 * of the app, not built, and it never runs on its own.
 */
import { app, BrowserWindow, desktopCapturer, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
const { carryIndicator } = await import('../packages/desktop/dist/main/carry-indicator.js');

const RECT = { left: 220, top: 150, width: 880, height: 540 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });

  const mock = new BrowserWindow({
    ...{ x: RECT.left, y: RECT.top, width: RECT.width, height: RECT.height },
    frame: false,
    backgroundColor: '#11151f',
    webPreferences: { offscreen: false },
  });
  await mock.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><html><body style="margin:0;font-family:Segoe UI;background:#11151f;color:#8fa3b8;">
        <div style="padding:26px 30px">
          <div style="height:26px;display:flex;align-items:center;gap:8px">
            <div style="width:9px;height:9px;border-radius:50%;background:#5b6b7f"></div>
            <div style="font-size:12px;letter-spacing:.12em;color:#6b7d93">MOCK WINDOW</div>
            <div style="margin-left:auto;display:flex;gap:16px;font-size:15px;color:#3d4a5c">&#8211; &#9744; &#10005;</div>
          </div>
          <div style="margin-top:34px;font-size:26px;color:#dbe6f2;font-weight:600">A normal app window</div>
          <div style="margin-top:10px;font-size:14px;line-height:1.6;max-width:520px">
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. This stands in for
            whatever the user actually grabbed, so the overlay can be judged against real
            window content instead of a blank rectangle.
          </div>
          <div style="margin-top:26px;display:flex;gap:30px">
            ${Array.from({ length: 3 }, (_, i) => `<div style="flex:1;height:120px;border-radius:10px;background:#1a2130;border:1px solid #232c3d"></div>`).join('')}
          </div>
        </div>
      </body></html>`)
  );
  // Every window on this machine opens maximised (measured: a bare frameless
  // BrowserWindow is reported maximised at creation), so the mock has to be
  // restored before it can stand in for a window being carried.
  mock.unmaximize();
  mock.setBounds({ x: RECT.left, y: RECT.top, width: RECT.width, height: RECT.height });
  await sleep(400);
  console.log('mock after create ', JSON.stringify(mock.getBounds()), 'maximised:', mock.isMaximized());

  const probe = async (label) => {
    const overlay = BrowserWindow.getAllWindows().find((w) => w !== mock);
    if (!overlay || overlay.isDestroyed()) return console.log(label, '-> overlay gone');
    try {
      const cls = await overlay.webContents.executeJavaScript('document.getElementById("root").className');
      const labelText = await overlay.webContents.executeJavaScript('document.getElementById("label").textContent');
      console.log(label, '-> class:', JSON.stringify(cls), 'label:', JSON.stringify(labelText));
    } catch (error) {
      console.log(label, '-> probe failed', error.message);
    }
  };

  const capture = async (name, rect = RECT) => {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    const full = source.thumbnail;
    // Crop to the mock window plus the overlay's padding, in physical pixels.
    const box = {
      x: Math.round((rect.left - 60) * scale),
      y: Math.round((rect.top - 60) * scale),
      width: Math.round((rect.width + 120) * scale),
      height: Math.round((rect.height + 120) * scale),
    };
    const cropped = full.crop({
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, full.getSize().width - Math.max(0, box.x)),
      height: Math.min(box.height, full.getSize().height - Math.max(0, box.y)),
    });
    writeFileSync(join(outDir, `${name}.png`), cropped.toPNG());
    console.log('wrote', join(outDir, `${name}.png`), cropped.getSize());
  };

  // hold
  carryIndicator().show(RECT);
  await sleep(600);
  const overlayEarly = BrowserWindow.getAllWindows().find((w) => w !== mock);
  console.log('overlay at show ', JSON.stringify(overlayEarly.getBounds()), 'maximised:', overlayEarly.isMaximized());
  await sleep(800);
  await probe('hold');
  await capture('1-hold');

  // aiming at the iPad
  carryIndicator().setState('aim');
  await sleep(700);
  await probe('aim');
  await capture('2-aim');

  // sent flash - captured immediately, before SENT_MS tears the overlay down
  carryIndicator().finish('sent');
  await sleep(120);
  await probe('sent');
  await capture('3-sent');

  // Drag: the mock window and the overlay are moved by the same deltas, the way
  // ipc.ts moves both every frame while a fist holds the window.
  await sleep(700);
  carryIndicator().show({ left: RECT.left, top: RECT.top, width: RECT.width, height: RECT.height });
  await sleep(300);
  const moved = { x: RECT.left + 130, y: RECT.top + 60 };
  mock.setBounds({ x: moved.x, y: moved.y, width: RECT.width, height: RECT.height });
  await sleep(120);
  console.log('mock after setBounds', JSON.stringify(mock.getBounds()));
  carryIndicator().move(moved.x, moved.y);
  await sleep(500);
  const overlay = BrowserWindow.getAllWindows().find((w) => w !== mock);
  const got = overlay.getBounds();
  const want = { x: moved.x - 22, y: moved.y - 22, width: RECT.width + 44, height: RECT.height + 44 };
  const same = ['x', 'y', 'width', 'height'].every((k) => got[k] === want[k]);
  console.log('overlay bounds', JSON.stringify(got), 'expected', JSON.stringify(want), same ? 'ALIGNED' : 'MISALIGNED');
  console.log('mock bounds   ', JSON.stringify(mock.getBounds()));
  await capture('4-dragged', { ...RECT, left: moved.x, top: moved.y });

  await sleep(200);
  mock.destroy();
  carryIndicator().destroy();
  app.quit();
});
