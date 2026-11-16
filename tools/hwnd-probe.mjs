/**
 * Checks the assumption the grab fix depends on:
 *
 *   a capture source id is `window:<HWND as decimal>:<n>`,
 *   and <HWND> is the same handle the PowerShell window helper reports.
 *
 *   npx electron tools/hwnd-probe.mjs
 *
 * Prints the harness window's own handle and the matching source id, so the
 * mapping is verified rather than assumed. Development only.
 */
import { app, BrowserWindow, desktopCapturer } from 'electron';

const TITLE = 'HWND PROBE WINDOW';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 200, y: 140, width: 700, height: 460, title: TITLE });
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent('<!doctype html><body style="margin:0;background:#0a7">HWND PROBE</body>'),
  );
  win.show();
  win.focus();
  await new Promise((r) => setTimeout(r, 1500));

  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
  console.log('own HWND:', hwnd);

  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 } });
  for (const s of sources) {
    const size = s.thumbnail.getSize();
    let bright = -1;
    try {
      const small = s.thumbnail.resize({ width: 8, height: 8 }).toBitmap();
      let sum = 0;
      for (let i = 0; i < small.length; i += 4) sum += (small[i] + small[i + 1] + small[i + 2]) / 3;
      bright = Math.round(sum / (small.length / 4));
    } catch {
      /* thumbnail unusable */
    }
    const match = s.id.startsWith(`window:${hwnd}:`) ? '  <== own window' : '';
    console.log(`${JSON.stringify(s.name)} id=${s.id} thumb=${size.width}x${size.height} b=${bright}${match}`);
  }

  app.quit();
});
