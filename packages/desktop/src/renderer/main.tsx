import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { bridgeAvailable } from './env.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

/**
 * Without the preload bridge nothing in the app can work. Say so explicitly:
 * a blank window is the worst possible failure mode.
 */
if (!bridgeAvailable()) {
  root.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;padding:40px;font-family:system-ui,sans-serif;color:#eef1f6">
      <div style="max-width:520px;text-align:center">
        <div style="font-weight:700;letter-spacing:.16em;font-size:12px;color:#93a0b4;margin-bottom:20px">ORBIT</div>
        <h1 style="font-size:20px;margin:0 0 10px">Desktop bridge unavailable</h1>
        <p style="color:#93a0b4;font-size:14px;line-height:1.6;margin:0">
          The app was opened outside its Electron window, or the preload script failed to load.
          Launch ORBIT with <code style="background:#131823;padding:2px 6px;border-radius:5px">npm run dev:desktop</code>.
        </p>
      </div>
    </div>`;
} else {
  /**
   * A bad gesture frame must not take the window down.
   *
   * Reported: "when I disable control of mouse pointer with hand to recenter
   * cursor and then enable it back, and then pinch, the app just crashes.
   * Everything just freezes and I have to close and reopen it."
   *
   * Gesture events arrive ~30 times a second and carry data produced by a
   * separate Python process. There was no error boundary and no global handler,
   * so a single throw while handling one of those events unmounted the entire
   * React tree: the window stayed open but stopped painting anything, which is
   * the freeze described. Catching per event means one malformed frame is
   * skipped and the next one - 33 ms later - is drawn normally.
   */
  window.addEventListener('error', (event) => {
    console.error('[orbit] renderer error (ignored):', event.message, event.error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[orbit] renderer rejection (ignored):', event.reason);
  });

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
