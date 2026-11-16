import { BrowserWindow, screen } from 'electron';
import { log } from './log.js';

/**
 * The "you are holding a window" overlay.
 *
 * A fist grab was invisible: the window moved, so *something* must be happening,
 * but the app gave no sign that a carry was live, which way it was going, or that
 * a released hand was the confirmation. The user had to guess whether they were
 * holding a window or just waving.
 *
 * It has to sit on the window being carried, not in ORBIT's own panel - the eyes
 * are on the thing being moved, and ORBIT is usually behind it. So this is a
 * separate transparent, click-through, always-on-top window sized to the grabbed
 * window plus a padding ring, drawing a glow around it.
 *
 * Everything is drawn in the padding or as a rim: the overlay is on top of
 * another application's pixels, so filling the middle would hide the thing the
 * user is trying to see.
 */

/** Space around the grabbed window for the glow to spill into, in DIP. */
const PAD = 22;
/** Time the "sent" flash gets before the overlay goes away. */
const SENT_MS = 950;
/** Fade-out duration, matched by the CSS transition. */
const FADE_MS = 200;

export type CarryState = 'hold' | 'aim' | 'sent' | 'dropped';

export interface CarryRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The overlay page.
 *
 * Kept as a string rather than a bundled renderer entry: it is one static
 * document with no build step and no preload, so it cannot drift from the build
 * that ships it, and it works the same in dev and packaged.
 */
const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @property --spin { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; overflow: hidden; background: transparent;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #root { position: absolute; inset: 0; opacity: 0; transition: opacity ${FADE_MS}ms ease; }
  #root.on { opacity: 1; }

  .frame { position: absolute; inset: ${PAD}px; border-radius: 15px; }

  /* Spills outside the carried window: the halo that says "this one is held". */
  .frame::after {
    content: ''; position: absolute; inset: -5px; border-radius: 20px; pointer-events: none;
    box-shadow:
      0 0 30px 1px rgba(34, 211, 238, 0.30),
      0 0 80px 8px rgba(139, 92, 246, 0.20);
    animation: breathe 2.6s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: 0.75; }
    50% { opacity: 1; }
  }

  /* Animated gradient hairline, masked into a border ring. */
  .ring {
    position: absolute; inset: 0; border-radius: 15px; padding: 2px;
    background: conic-gradient(from var(--spin), #22d3ee, #6366f1, #a855f7, #22d3ee);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    animation: spin 3.6s linear infinite;
  }
  @keyframes spin { to { --spin: 360deg; } }

  /* Edge-only tint: enough to read as "selected", not enough to hide the app. */
  .rim {
    position: absolute; inset: 0; border-radius: 15px; pointer-events: none;
    box-shadow: inset 0 0 24px rgba(34, 211, 238, 0.15), inset 0 0 3px rgba(34, 211, 238, 0.45);
  }

  .corner {
    position: absolute; width: 26px; height: 26px; border: 3px solid #67e8f9;
    animation: pulse 1.8s ease-in-out infinite;
  }
  .corner.tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; border-top-left-radius: 14px; }
  .corner.tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; border-top-right-radius: 14px; animation-delay: 0.15s; }
  .corner.bl { bottom: -1px; left: -1px; border-right: 0; border-top: 0; border-bottom-left-radius: 14px; animation-delay: 0.3s; }
  .corner.br { bottom: -1px; right: -1px; border-left: 0; border-top: 0; border-bottom-right-radius: 14px; animation-delay: 0.45s; }
  @keyframes pulse {
    0%, 100% { opacity: 0.72; }
    50% { opacity: 1; }
  }

  .pill {
    position: absolute; left: 14px; top: 12px; display: flex; align-items: center; gap: 10px;
    padding: 8px 15px 8px 12px; border-radius: 12px;
    background: rgba(7, 11, 18, 0.82);
    border: 1px solid rgba(103, 232, 249, 0.32);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.07);
    transition: border-color 200ms ease, background 200ms ease;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; background: #22d3ee;
    box-shadow: 0 0 12px #22d3ee; animation: blink 1.3s ease-in-out infinite;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.82); }
  }
  .text { display: flex; flex-direction: column; }
  .label {
    font-size: 11.5px; font-weight: 700; letter-spacing: 0.15em;
    color: #e6f9ff; transition: color 200ms ease;
  }
  .sub {
    margin-top: 2px; font-size: 10.5px; letter-spacing: 0.01em; color: #93a6ba;
    transition: color 200ms ease;
  }

  /* Aiming at the iPad: the same carry, one step further along. */
  #root.aim .pill { border-color: rgba(168, 85, 247, 0.55); background: rgba(14, 8, 24, 0.86); }
  #root.aim .dot { background: #c084fc; box-shadow: 0 0 12px #c084fc; animation-duration: 0.7s; }
  #root.aim .label { color: #f5e9ff; }
  #root.aim .sub { color: #c4b5fd; }
  #root.aim .frame::after {
    box-shadow:
      0 0 34px 2px rgba(168, 85, 247, 0.42),
      0 0 96px 10px rgba(236, 72, 153, 0.22);
    animation: breathe 0.9s ease-in-out infinite;
  }
  #root.aim .rim { box-shadow: inset 0 0 26px rgba(168, 85, 247, 0.20), inset 0 0 3px rgba(192, 132, 252, 0.5); }
  #root.aim .corner { border-color: #d8b4fe; }

  /* Sent: one bright flash, then gone. */
  #root.sent .pill { border-color: rgba(52, 211, 153, 0.65); background: rgba(4, 20, 16, 0.88); }
  #root.sent .dot { background: #34d399; box-shadow: 0 0 14px #34d399; animation: none; }
  #root.sent .label { color: #d1fae5; }
  #root.sent .sub { color: #6ee7b7; }
  #root.sent .frame::after {
    box-shadow: 0 0 44px 6px rgba(52, 211, 153, 0.55), 0 0 110px 16px rgba(34, 211, 238, 0.30);
    animation: none;
  }
  #root.sent .ring { background: conic-gradient(from var(--spin), #34d399, #22d3ee, #a7f3d0, #34d399); }
  #root.sent .rim { box-shadow: inset 0 0 30px rgba(52, 211, 153, 0.30); }
  #root.sent .corner { border-color: #6ee7b7; animation: none; opacity: 1; }

  /* Dropped or cancelled: grey, no ceremony. */
  #root.dropped .pill { border-color: rgba(148, 163, 184, 0.35); }
  #root.dropped .dot { background: #94a3b8; box-shadow: 0 0 10px #94a3b8; animation: none; }
  #root.dropped .label { color: #cbd5e1; }
  #root.dropped .sub { color: #7c8b9c; }
  #root.dropped .frame::after { box-shadow: 0 0 24px rgba(148, 163, 184, 0.18); animation: none; }
  #root.dropped .ring { background: conic-gradient(from var(--spin), #475569, #94a3b8, #475569); animation: none; }
  #root.dropped .corner { border-color: #64748b; animation: none; }
  #root.dropped .rim { box-shadow: inset 0 0 20px rgba(148, 163, 184, 0.12); }

  .burst {
    position: absolute; inset: 0; border-radius: 15px; border: 2px solid #6ee7b7;
    opacity: 0; pointer-events: none;
  }
  #root.sent .burst { animation: burst 620ms ease-out forwards; }
  @keyframes burst {
    0% { opacity: 0.9; transform: scale(1); }
    100% { opacity: 0; transform: scale(1.035); }
  }
</style>
</head>
<body>
  <div id="root">
    <div class="frame">
      <div class="rim"></div>
      <div class="ring"></div>
      <div class="burst"></div>
      <div class="corner tl"></div>
      <div class="corner tr"></div>
      <div class="corner bl"></div>
      <div class="corner br"></div>
      <div class="pill">
        <div class="dot"></div>
        <div class="text">
          <div class="label" id="label">WINDOW GRABBED</div>
          <div class="sub" id="sub">drag to move · look at the iPad, then open your hand</div>
        </div>
      </div>
    </div>
  </div>
<script>
  var COPY = {
    hold:    ['WINDOW GRABBED', 'drag to move · look at the iPad, then open your hand'],
    aim:     ['READY TO SEND', 'open your hand to hand it to the iPad'],
    sent:    ['SENT TO IPAD', 'the preview is on your tablet'],
    dropped: ['LET GO', 'the window stays here'],
  };
  function set(state) {
    var root = document.getElementById('root');
    root.className = state === 'hold' ? 'on' : 'on ' + state;
    var copy = COPY[state] || COPY.hold;
    document.getElementById('label').textContent = copy[0];
    document.getElementById('sub').textContent = copy[1];
  }
  function fade() {
    document.getElementById('root').className = '';
  }
  window.carry = { set: set, fade: fade };
  set('hold');
</script>
</body>
</html>`;

class CarryIndicator {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private pendingState: CarryState | null = 'hold';
  private rect: CarryRect | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Put the overlay on a window. Safe to call again while one is showing. */
  show(rect: CarryRect): void {
    this.rect = rect;
    if (!this.win || this.win.isDestroyed()) {
      this.create();
      return;
    }
    this.place();
  }

  /**
   * Follow the carried window while it is being dragged.
   *
   * Only the top-left moves - the helper moves the window by its corner - so the
   * size stays whatever was measured when the grab started.
   */
  move(left: number, top: number): void {
    if (!this.rect) return;
    if (Math.abs(this.rect.left - left) < 1 && Math.abs(this.rect.top - top) < 1) return;
    this.rect = { ...this.rect, left, top };
    if (this.win && !this.win.isDestroyed()) this.place();
  }

  /** Switch the wording. Called on state changes, never per frame. */
  setState(state: CarryState): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingState = state;
    if (state === 'sent') {
      this.send(state);
      // Long enough to read "SENT TO IPAD", then the window is dropped.
      this.timer = setTimeout(() => this.destroy(), SENT_MS);
      return;
    }
    this.send(state);
  }

  /** The carry ended without going anywhere. Fades out instead of vanishing. */
  finish(state: 'dropped' | 'sent'): void {
    this.setState(state);
    if (state === 'dropped') {
      this.timer = setTimeout(() => this.destroy(), 380);
    }
  }

  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const win = this.win;
    this.win = null;
    this.loaded = false;
    this.rect = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private create(): void {
    const rect = this.rect;
    if (!rect) return;
    const place = this.boundsFor(rect);
    const win = new BrowserWindow({
      ...place,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      // Never take focus: the window being carried still owns the foreground,
      // and the helper picks its grab target from the foreground window.
      focusable: false,
      acceptFirstMouse: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.win = win;
    this.loaded = false;

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Everything below this line has to reach whatever is underneath.
    win.setIgnoreMouseEvents(true, { forward: true });

    win.webContents.once('did-finish-load', () => {
      this.loaded = true;
      if (!this.win || this.win.isDestroyed()) return;
      // Re-assert the geometry: this machine hands new windows bounds other than
      // the ones requested (every plain window here opens maximised), and a
      // full-screen ring over one window would be worse than no ring at all.
      this.place();
      if (this.pendingState) this.send(this.pendingState);
      // `showInactive` so a grab does not steal the foreground from the window
      // the user is actually dragging.
      this.win.showInactive();
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      log.warn('carry', 'Carry indicator renderer gone.', details);
      this.destroy();
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((error: unknown) => {
      log.warn('carry', 'Carry indicator failed to load.', error);
      this.destroy();
    });
  }

  /** Window bounds for a carried rect: the rect plus the glow padding. */
  private boundsFor(rect: CarryRect): { x: number; y: number; width: number; height: number } {
    const display = screen.getDisplayMatching({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    const b = display.bounds;
    // A glow that spills off the screen is simply clipped; a window placed off
    // the screen entirely would not be composited at all on Windows, so the
    // frame is kept on-screen even for a window hanging over the edge.
    const x = Math.max(b.x - PAD * 2, Math.round(rect.left) - PAD);
    const y = Math.max(b.y - PAD * 2, Math.round(rect.top) - PAD);
    return {
      x,
      y,
      width: Math.max(80, Math.round(rect.width) + PAD * 2),
      height: Math.max(80, Math.round(rect.height) + PAD * 2),
    };
  }

  private place(): void {
    const win = this.win;
    const rect = this.rect;
    if (!win || win.isDestroyed() || !rect) return;
    try {
      win.setBounds(this.boundsFor(rect));
    } catch (error) {
      log.warn('carry', 'Carry indicator could not be moved.', error);
    }
  }

  private send(state: CarryState): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded) return;
    // One tiny eval per state change. Geometry is carried by the window's own
    // bounds, so nothing has to be pushed 30 times a second.
    win.webContents
      .executeJavaScript(`window.carry && window.carry.set(${JSON.stringify(state)})`, true)
      .catch(() => {
        /* the overlay is best-effort decoration; never let it break a grab */
      });
  }
}

let indicator: CarryIndicator | null = null;

/**
 * The one carry indicator.
 *
 * A singleton because `window-all-closed` quits the app: a second visible window
 * that outlives ORBIT's own window would keep the process alive with no UI. The
 * main window's `closed` handler disposes this before the quit check runs.
 */
export function carryIndicator(): CarryIndicator {
  indicator ??= new CarryIndicator();
  return indicator;
}
