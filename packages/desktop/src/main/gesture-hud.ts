import { BrowserWindow, screen } from 'electron';
import { log } from './log.js';

/**
 * The left-hand gesture overlay.
 *
 * Requested: "try adding a visual indicator again when I grab with my left
 * hand." The left fist has no visible effect until a desktop has already moved,
 * so there is nothing to tell "the gesture is not being recognised" apart from
 * "the gesture is recognised and the switch is not happening". This overlay says
 * which of those is true, while the hand is still closed.
 *
 * It is the same idea as the carry ring, and built the same way: a separate
 * transparent, click-through, never-focused window, so it cannot steal a click
 * from whatever the user is actually working in. It sits at the bottom centre of
 * the primary display - out of the way of window title bars and of ORBIT itself.
 */

const WIDTH = 420;
const HEIGHT = 96;
/** How far above the bottom edge it floats, in DIP. */
const MARGIN_BOTTOM = 18;
/** How long a committed switch stays on screen. */
const FLASH_MS = 1100;

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; overflow: hidden; background: transparent;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #root {
    position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; opacity: 0; transition: opacity 140ms ease;
  }
  #root.on { opacity: 1; }
  .pill {
    display: flex; align-items: center; gap: 12px;
    min-width: 260px; max-width: 100%;
    padding: 12px 18px;
    border-radius: 16px;
    background: rgba(16, 17, 22, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.42);
    color: #f5f5f7;
    backdrop-filter: blur(14px);
  }
  .dot {
    width: 10px; height: 10px; border-radius: 50%; flex: none;
    background: #22d3ee;
    box-shadow: 0 0 12px rgba(34, 211, 238, 0.8);
  }
  .body { flex: 1; min-width: 0; }
  .label {
    font-size: 12px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: #a5f3fc;
  }
  .sub { font-size: 12px; color: rgba(245, 245, 247, 0.66); margin-top: 3px; }
  /* The slide, drawn as it happens: the fill grows in the direction the hand is
     moving, so a partial swipe is visibly partial. */
  .track {
    position: relative; height: 4px; margin-top: 9px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.12); overflow: hidden;
  }
  .fill {
    position: absolute; top: 0; bottom: 0; width: 0%;
    background: linear-gradient(90deg, #22d3ee, #a855f7);
    transition: width 90ms linear, left 90ms linear, right 90ms linear;
  }
  /* Committed: the whole pill turns, so the switch is unmistakable even if the
     user is not looking straight at it. */
  #root.flash .pill {
    background: rgba(34, 211, 238, 0.92);
    border-color: rgba(255, 255, 255, 0.5);
    color: #0b1116;
  }
  #root.flash .label { color: #0b1116; }
  #root.flash .sub { color: rgba(11, 17, 22, 0.7); }
  #root.flash .dot { background: #0b1116; box-shadow: none; }
</style>
</head>
<body>
  <div id="root">
    <div class="pill">
      <div class="dot"></div>
      <div class="body">
        <div class="label" id="label">LEFT HAND CLOSED</div>
        <div class="sub" id="sub">slide sideways to change desktop</div>
        <div class="track"><div class="fill" id="fill"></div></div>
      </div>
    </div>
  </div>
<script>
  var root = document.getElementById('root');
  var label = document.getElementById('label');
  var sub = document.getElementById('sub');
  var fill = document.getElementById('fill');
  var flashTimer = null;

  function slide(progress, wording) {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    root.className = 'on';
    label.textContent = 'LEFT HAND CLOSED';
    sub.textContent = wording;
    var p = Math.max(-1, Math.min(1, progress || 0));
    var width = Math.abs(p) * 100;
    fill.style.width = width + '%';
    // Fill from the middle outwards, in the direction of travel.
    fill.style.left = p >= 0 ? '50%' : (50 - width) + '%';
    fill.style.right = 'auto';
  }

  function flash(text, detail) {
    if (flashTimer) clearTimeout(flashTimer);
    root.className = 'on flash';
    label.textContent = text;
    sub.textContent = detail || '';
    fill.style.width = '100%';
    fill.style.left = '0%';
    flashTimer = setTimeout(function () { root.className = ''; }, ${FLASH_MS});
  }

  function hide() {
    if (flashTimer) return;
    root.className = '';
  }

  window.hud = { slide: slide, flash: flash, hide: hide };
  hide();
</script>
</body>
</html>`;

class GestureHud {
  private win: BrowserWindow | null = null;
  private loaded = false;
  /** Whether the overlay is currently showing the left hand. */
  private showing = false;
  /** Last values sent, so identical frames are not re-sent at 30 Hz. */
  private lastClosed = false;
  private lastStep = 99;
  private lastFlash = { text: '', at: 0 };
  private hideTimer: NodeJS.Timeout | null = null;

  /**
   * Show how far the left fist has slid toward the next screen.
   *
   * Called from the status stream, so it must stay cheap: nothing is sent unless
   * the state or the rounded progress actually changed.
   */
  leftHand(closed: boolean, progress: number): void {
    if (!closed) {
      if (!this.showing) return;
      this.showing = false;
      this.lastClosed = false;
      this.lastStep = 99;
      // A short linger so the pill does not blink between two closed frames.
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (!this.showing) this.run('window.hud && hud.hide()');
      }, 220);
      this.hideTimer.unref?.();
      return;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const step = Math.round(Math.max(-1, Math.min(1, progress)) * 20);
    if (this.showing && this.lastClosed && step === this.lastStep) return;
    this.showing = true;
    this.lastClosed = true;
    this.lastStep = step;
    this.run(
      `window.hud && hud.slide(${(step / 20).toFixed(2)}, ${JSON.stringify(this.wording(progress))})`,
    );
  }

  /** Announce a committed change: a desktop moved, or a cast window paged. */
  flash(text: string, detail: string): void {
    const now = Date.now();
    // Two switches in one gesture can arrive within a frame of each other; the
    // second would only flicker over the first.
    if (this.lastFlash.text === text && now - this.lastFlash.at < 400) return;
    this.lastFlash = { text, at: now };
    this.showing = false;
    this.lastClosed = false;
    this.lastStep = 99;
    this.run(`window.hud && hud.flash(${JSON.stringify(text)}, ${JSON.stringify(detail)})`);
  }

  destroy(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const win = this.win;
    this.win = null;
    this.loaded = false;
    this.showing = false;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private wording(progress: number): string {
    if (Math.abs(progress) < 0.08) return 'slide sideways to change desktop';
    return progress > 0 ? 'sliding right…' : 'sliding left…';
  }

  private run(script: string): void {
    const win = this.ensure();
    if (!win) return;
    if (!this.loaded) return;
    win.webContents.executeJavaScript(script, true).catch(() => undefined);
  }

  private ensure(): BrowserWindow | null {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const display = screen.getPrimaryDisplay();
    const x = Math.round(display.workArea.x + (display.workArea.width - WIDTH) / 2);
    const y = Math.round(display.workArea.y + display.workArea.height - HEIGHT - MARGIN_BOTTOM);
    try {
      const win = new BrowserWindow({
        x,
        y,
        width: WIDTH,
        height: HEIGHT,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        focusable: false,
        // Above normal windows but below the carry ring, which has to stay
        // visible on top of the window being dragged.
        alwaysOnTop: false,
        hasShadow: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      // Never take a click, never take focus: this is decoration over someone
      // else's work.
      win.setIgnoreMouseEvents(true, { forward: false });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true);
      this.win = win;
      this.loaded = false;
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
      win.webContents.once('did-finish-load', () => {
        this.loaded = true;
      });
      win.once('ready-to-show', () => win.showInactive());
      win.on('closed', () => {
        this.win = null;
        this.loaded = false;
      });
      log.info('hud', 'Left-hand overlay created.');
      return win;
    } catch (error) {
      log.warn('hud', 'Could not create the left-hand overlay.', error);
      return null;
    }
  }
}

let instance: GestureHud | null = null;

/** The overlay, created on first use. */
export function gestureHud(): GestureHud {
  if (!instance) instance = new GestureHud();
  return instance;
}

export type { GestureHud };
