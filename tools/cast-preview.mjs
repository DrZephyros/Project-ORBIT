/**
 * End-to-end cast harness.
 *
 *   npx electron tools/cast-preview.mjs
 *
 * Reproduces what the app does when a window is sent to the iPad, minus the iPad:
 * enumerate a real window source, capture it with the same Electron constraints
 * `useSenders` uses, push it through a real RTCPeerConnection to a second peer in
 * the same process, decode it into a `<video>`, and measure the decoded pixels.
 *
 * Prints: track settings, connection state, frames decoded, and the mean
 * brightness of a decoded frame (0 means "black screen", which is the report).
 * Development only - not part of the app.
 */
import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET_TITLE = 'CAST TEST TARGET';

const TESTER_PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="64" height="40"></canvas>
<video id="v" muted playsinline></video>
<script>
const sourceId = decodeURIComponent(location.hash.slice(1));

async function run() {
  const out = { steps: [] };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1200,
          maxFrameRate: 30,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    out.track = track ? track.getSettings() : null;
    out.steps.push('captured');

    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});

    let remote = null;
    b.ontrack = (e) => { remote = e.streams[0] || new MediaStream([e.track]); };
    a.addTrack(track, stream);

    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    out.steps.push('negotiated');

    // Wait for decoded frames.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !remote) await new Promise((r) => setTimeout(r, 100));
    out.gotStream = Boolean(remote);

    const v = document.getElementById('v');
    if (remote) {
      v.srcObject = remote;
      await v.play().catch((e) => { out.playError = String(e); });
    }
    while (Date.now() < deadline && !(v.videoWidth > 0)) await new Promise((r) => setTimeout(r, 100));

    out.video = { width: v.videoWidth, height: v.videoHeight, readyState: v.readyState };
    out.connection = { sender: a.connectionState, receiver: b.connectionState };

    // Decoded pixel brightness: a black screen decodes to 0 here too.
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    let best = 0;
    for (let i = 0; i < 12; i += 1) {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let p = 0; p < data.length; p += 4) sum += (data[p] + data[p + 1] + data[p + 2]) / 3;
      best = Math.max(best, sum / (data.length / 4));
      await new Promise((r) => setTimeout(r, 150));
    }
    out.brightness = Math.round(best);

    const stats = await b.getStats();
    stats.forEach((entry) => {
      if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
        out.inbound = { framesDecoded: entry.framesDecoded, frameWidth: entry.frameWidth, frameHeight: entry.frameHeight };
      }
    });
  } catch (error) {
    out.error = String(error && error.message ? error.message : error);
  }
  console.log('TESTER_RESULT ' + JSON.stringify(out));
}
run();
</script></body></html>`;

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  const target = new BrowserWindow({
    x: 120,
    y: 90,
    width: 880,
    height: 520,
    title: TARGET_TITLE,
    backgroundColor: '#1e6fff',
  });
  await target.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<!doctype html><html><body style="margin:0;background:#1e6fff;color:#fff;font:700 46px sans-serif">
           <div style="padding:60px">CAST TEST TARGET</div>
           <div style="margin:20px 60px;height:180px;background:#ffd166"></div>
         </body></html>`,
      ),
  );
  await new Promise((r) => setTimeout(r, 1200));

  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 } });
  const brightness = (image) => {
    try {
      const small = image.resize({ width: 8, height: 8 }).toBitmap();
      let sum = 0;
      for (let i = 0; i < small.length; i += 4) sum += (small[i] + small[i + 1] + small[i + 2]) / 3;
      return Math.round(sum / (small.length / 4));
    } catch {
      return 0;
    }
  };
  console.log(
    'sources:',
    sources.map((s) => `${s.name} (${s.id}) b=${brightness(s.thumbnail)}`).join(' | '),
  );
  // Prefer the harness's own window; otherwise use any real, non-black window so
  // the WebRTC path is still exercised.
  const source =
    sources.find((s) => s.name === TARGET_TITLE) ??
    sources.find((s) => s.name !== 'Status' && brightness(s.thumbnail) > 2);
  if (!source) {
    console.log('FAIL: no capturable window was enumerable');
    app.quit();
    return;
  }
  console.log('capturing:', source.name, source.id);

  const tester = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { contextIsolation: true } });
  tester.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('TESTER_RESULT')) {
      const result = JSON.parse(message.slice('TESTER_RESULT '.length));
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[tester]', message);
    }
  });
  // A data: URL is not a secure context, so `navigator.mediaDevices` does not
  // exist there and every capture would fail before it started. A file: URL is
  // a secure context, so the page is written to disk first.
  const pagePath = join(tmpdir(), 'orbit-cast-preview.html');
  writeFileSync(pagePath, TESTER_PAGE, 'utf8');
  await tester.loadFile(pagePath, { hash: source.id });

  // Hard stop so the harness cannot hang.
  setTimeout(() => {
    app.quit();
  }, 20000);
});
