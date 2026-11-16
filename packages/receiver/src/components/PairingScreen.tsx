import { useEffect, useRef, useState } from 'react';
import type { LinkState, RemoteError } from '../lib/link.js';

interface Props {
  state: LinkState;
  error: RemoteError | null;
  rejections: number;
  onSubmit: (code: string) => void;
  /** The code from the scanned QR, shown in the cells as the fallback. */
  initialCode?: string | null;
  /** Force an immediate socket open instead of waiting for the retry backoff. */
  onReconnect?: () => void;
}

const LENGTH = 6;

function digitsOf(code: string | null | undefined): string[] {
  const clean = (code ?? '').replace(/\D/g, '').slice(0, LENGTH);
  return Array.from({ length: LENGTH }, (_, index) => clean[index] ?? '');
}

/**
 * Where the iPad downloads the local CA.
 *
 * This has to be plain HTTP: the HTTPS side is exactly what Safari is refusing
 * to trust, so the download cannot live behind it. The port matches the
 * server's default plain-HTTP helper port (ORBIT_HTTP_PORT).
 */
function certificateUrl(): string | null {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return null;
  return `http://${window.location.hostname}:8788/cert`;
}

/**
 * Pairing screen: six digit entry.
 *
 * The QR code on the laptop carries `#c=123456`. That fragment is read by the
 * link hook *before* the first socket opens, so scanning joins on that socket
 * instead of racing a second one.
 *
 * The digits are also pre-filled from that code. Auto-join is the happy path,
 * but if the laptop cannot be reached the user lands here — and an empty form
 * looks like the scan did nothing. Showing the code makes it obvious what was
 * read, and makes "Connect" a working retry once the network is back.
 */
export function PairingScreen({ state, error, rejections, onSubmit, initialCode, onReconnect }: Props) {
  const [digits, setDigits] = useState<string[]>(() => digitsOf(initialCode));
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  // A QR scan can run before the hash is parsed in a hot-reload/dev path; adopt
  // the code when it arrives so the cells are never mysteriously blank.
  useEffect(() => {
    if (!initialCode) return;
    setDigits((current) => (current.join('') ? current : digitsOf(initialCode)));
  }, [initialCode]);

  const code = digits.join('');
  const complete = code.length === LENGTH;
  // Only a join in flight disables the form. "Connecting" and "offline" used to
  // count as busy too, so a receiver that could not reach the laptop flickered
  // between a spinner and a dead button every few seconds and could never be
  // retried by hand.
  // "Pairing" is the only genuinely busy state. It must also be *escapable*: if
  // the join hangs, the user needs a way back, so the button stays enabled once
  // an error has been reported.
  const busy = state === 'pairing' && !error;

  // One button, two meanings: a full code joins, an empty or partial one just
  // reopens the socket. Showing both at once was confusing, and the Connect
  // button looked broken because it had nothing to submit.
  const canReconnect = Boolean(onReconnect);
  const disabled = busy || (!complete && !canReconnect);

  function submit(): void {
    if (complete) {
      onSubmit(code);
      return;
    }
    onReconnect?.();
  }

  function setAt(index: number, value: string): void {
    const numeric = value.replace(/\D/g, '');
    if (numeric.length > 1) {
      // Paste or fast typing: distribute across the remaining cells.
      const next = [...digits];
      for (let i = 0; i < numeric.length && index + i < LENGTH; i += 1) {
        next[index + i] = numeric[i]!;
      }
      setDigits(next);
      const target = Math.min(index + numeric.length, LENGTH - 1);
      inputs.current[target]?.focus();
      return;
    }
    const next = [...digits];
    next[index] = numeric;
    setDigits(next);
    if (numeric && index < LENGTH - 1) inputs.current[index + 1]?.focus();
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (event.key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < LENGTH - 1) inputs.current[index + 1]?.focus();
    if (event.key === 'Enter' && complete) onSubmit(code);
  }

  return (
    <div className="screen">
      <div className="pair">
        <span className="brand">
          <span className="brand-dot" />
          ORBIT
        </span>

        <h1>Connect to your laptop</h1>
        <p>Enter the six digit code shown in ORBIT on your Windows laptop.</p>

        <div className="code-input" role="group" aria-label="Pairing code">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(el) => {
                inputs.current[index] = el;
              }}
              className={`code-cell${digit ? ' filled' : ''}`}
              value={digit}
              onChange={(e) => setAt(index, e.target.value)}
              onKeyDown={(e) => onKeyDown(index, e)}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={`Digit ${index + 1}`}
              maxLength={LENGTH}
              disabled={busy}
            />
          ))}
        </div>

        <div className="error" role="status" aria-live="polite">
          {/* Show any server error verbatim. Filtering by code here used to hide
              'no-session', 'locked' and 'unauthorised' completely, so a failed
              join looked like a dead screen instead of a message. */}
          {error ? error.message : ''}
          {rejections >= 1
            ? ' Scan the QR code on the laptop again to get a fresh code; a code stops working once it has been used or replaced.'
            : ''}
        </div>

        <button className="btn btn-primary" onClick={submit} disabled={disabled}>
          {busy ? <span className="spinner" /> : complete ? 'Connect' : 'Reconnect'}
        </button>

        {state === 'offline' && (
          <p className="note">
            Cannot reach the laptop at {window.location.host}. Check that both devices are on the
            same Wi-Fi and that ORBIT is running.
          </p>
        )}
        {state === 'offline' && certificateUrl() && (
          <div className="note">
            <p>
              If the page loaded but the connection still fails, Safari is blocking the secure
              socket. Install the ORBIT certificate on this iPad:
            </p>
            <a className="btn btn-ghost" href={certificateUrl()!} style={{ marginTop: 8 }}>
              Install certificate
            </a>
            <p style={{ marginTop: 8 }}>
              Then open Settings → General → About → Certificate Trust Settings and turn on
              “ORBIT Local CA”, and tap Reconnect.
            </p>
          </div>
        )}
        {state === 'reconnecting' && <p className="note">Reconnecting to the laptop…</p>}

        <p className="note">
          Your iPad controls ORBIT and the shared workspace only. It never gains access to other
          iPad apps.
        </p>
      </div>
    </div>
  );
}
