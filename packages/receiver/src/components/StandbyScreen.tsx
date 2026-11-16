import { useEffect, useState } from 'react';
import type { SessionInfo } from '@orbit/shared';
import type { LinkState } from '../lib/link.js';

interface Props {
  state: LinkState;
  session: SessionInfo | null;
}

/**
 * Standby screen.
 *
 * A paired iPad with nothing being shared is the normal resting state, not an
 * error, so it shows a clock rather than a spinner or an empty canvas. The
 * clock also makes it obvious at a glance that the page is alive and ticking —
 * the previous blank "No panels yet" canvas looked identical to a hang.
 */
export function StandbyScreen({ state, session }: Props) {
  const now = useNow();

  const hours24 = now.getHours();
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const suffix = hours24 < 12 ? 'AM' : 'PM';
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const online = state === 'paired' && session?.phase !== 'ended';

  return (
    <div className="standby">
      <div className="standby-glow" aria-hidden="true" />

      <header className="standby-top">
        <span className="brand">
          <span className="brand-dot" />
          ORBIT
        </span>
        <span className="standby-link">
          <span className={`status-dot ${online ? 'live' : 'bad'}`} />
          {online ? 'Connected' : state === 'offline' ? 'Laptop unreachable' : 'Reconnecting'}
        </span>
      </header>

      <main className="standby-main">
        <div className="standby-clock" role="timer" aria-live="off">
          <span className="standby-time">
            {hours}
            <span className="standby-colon">:</span>
            {minutes}
          </span>
          <span className="standby-meta">
            <span className="standby-seconds">{seconds}</span>
            <span className="standby-suffix">{suffix}</span>
          </span>
        </div>
        <p className="standby-date">{date}</p>
      </main>

      <footer className="standby-foot">
        <p>
          {online
            ? 'Waiting for a window. Grab one on the laptop and look this way to bring it over.'
            : 'Trying to reach the laptop. Keep both devices on the same Wi-Fi.'}
        </p>
      </footer>
    </div>
  );
}

/**
 * Ticks on the second boundary rather than every 1000ms from mount, so the
 * displayed second changes when the wall clock does instead of drifting.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 1000 - (Date.now() % 1000));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}
