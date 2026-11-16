/**
 * Checks the receiver's single-window layout without an iPad.
 *
 *   npx electron tools/solo-layout-check.mjs
 *
 * Loads the receiver's real stylesheet around the same markup `Workspace` emits
 * for one panel (`solo` branch) and screenshots it at iPad Pro 11" logical size
 * (1024x768). Writes tools/out/solo-layout.png. Development only.
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'packages/receiver/src/styles.css'), 'utf8');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body,#root{height:100%;margin:0}</style></head><body>
<div id="root"><div class="ws ws-solo">
  <header class="ws-bar"><h2>Workspace</h2><div class="mode-toggle"><button class="active">Arrange</button><button>Interact</button></div></header>
  <div class="canvas">
    <div class="canvas-solo">
      <div class="panel" id="solo" style="left:0px;top:0px;width:100%;height:100%">
        <video style="opacity:1" id="v"></video>
        <div id="fill" style="position:absolute;inset:0;background:linear-gradient(160deg,#1e6fff,#0a2a5e)"></div>
      </div>
      <div class="solo-chrome" id="chrome">
        <span class="solo-title">Some Window</span>
        <span class="solo-dots"><button class="dot active"></button><button class="dot"></button></span>
        <button class="solo-btn">Back to laptop</button>
      </div>
    </div>
  </div>
  <footer class="ws-foot"><button>Return</button><button>Close</button></footer>
</div></div>
<script>
  // Report the measured geometry so "fills the screen" is a number, not an opinion.
  const solo = document.getElementById('solo');
  const canvas = document.querySelector('.canvas');
  const s = solo.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  console.log('GEOMETRY ' + JSON.stringify({
    canvas: { w: Math.round(c.width), h: Math.round(c.height) },
    panel: { w: Math.round(s.width), h: Math.round(s.height) },
    fillRatioW: +(s.width / c.width).toFixed(3),
    fillRatioH: +(s.height / c.height).toFixed(3),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    radius: getComputedStyle(solo).borderRadius,
    border: getComputedStyle(solo).borderTopWidth,
  }));
</script></body></html>`;

app.whenReady().then(async () => {
  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  const pagePath = join(outDir, 'solo-layout.html');
  writeFileSync(pagePath, page, 'utf8');

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    useContentSize: true,
    show: false,
    webPreferences: { offscreen: false },
  });
  win.webContents.on('console-message', (_e, _l, message) => {
    if (message.startsWith('GEOMETRY')) console.log(message.slice('GEOMETRY '.length));
  });
  await win.loadFile(pagePath);
  await new Promise((r) => setTimeout(r, 700));
  const image = await win.webContents.capturePage();
  const shot = join(outDir, 'solo-layout.png');
  writeFileSync(shot, image.toPNG());
  console.log('screenshot:', shot);
  app.quit();
});
