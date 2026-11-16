import { useEffect, useState } from 'react';
import type { SharedProps } from '../App.js';
import { api } from '../env.js';

/**
 * Setup / pairing — the only thing the user has to do.
 *
 * The QR code is drawn locally from the pairing URL — no third-party QR service
 * sees the address or the code. The camera starts with the app; a window only
 * reaches the iPad when a grab is released while looking at it, so connecting
 * lands the iPad on its standby clock rather than pushing content at it.
 */
export function SetupPage({ state }: SharedProps) {
  const [countdown, setCountdown] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state.pairing) {
      setCountdown(0);
      return;
    }
    const tick = (): void => setCountdown(Math.max(0, Math.round((state.pairing!.expiresAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [state.pairing]);

  // Local QR rendering. The payload is the receiver URL with the code in the
  // fragment, so the iPad can prefill it without an extra round trip. QR
  // encoding happens in the main process: no third-party service ever sees the
  // address or the pairing code.
  useEffect(() => {
    if (!state.pairing) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void api()
      .renderQr(state.pairing.qrPayload)
      .then((dataUrl: string) => {
        if (!cancelled) setQr(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.pairing]);

  const connected = (state.session?.receivers.length ?? 0) > 0;
  const certUrl = pairingCertUrl(state.pairing?.url);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connect your iPad</h1>
          <p>
            Scan the QR code in Safari — it carries the code, so pairing starts on its own. You can
            also open the address below and type the six digits. The iPad then shows a standby clock
            until you grab a window and open your hand while looking at it.
          </p>
        </div>
        <div className="actions">
          <span className={`badge ${connected ? 'accent' : ''}`}>{connected ? 'Connected' : 'Waiting'}</span>
        </div>
      </div>

      <div className="card">
        <h2>
          Pairing code
          <span className="sub">{connected ? 'A receiver is connected' : 'Waiting for a receiver'}</span>
        </h2>

        <div className="pair-grid">
          <div className="qr" aria-label="Pairing QR code">
            {qr ? (
              <img src={qr} alt="Scan to open the ORBIT receiver" />
            ) : (
              <span style={{ color: '#666', fontSize: 12 }}>Code unavailable</span>
            )}
          </div>

          <div>
            <div className="code" aria-live="polite">
              {state.pairing?.code ?? '——————'}
            </div>
            <div className="code-meta">
              {state.pairing
                ? `Expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')} · changes after each pairing`
                : 'Waiting for the local server to offer a code.'}
            </div>

            <div className="url-row" style={{ marginTop: 14 }}>
              <span className="val">{state.pairing?.url ?? 'http://—/r'}</span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  if (!state.pairing) return;
                  await navigator.clipboard.writeText(state.pairing.url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                disabled={!state.pairing}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void api().openReceiverPage()}
                disabled={!state.pairing}
              >
                Open
              </button>
            </div>

            <ol className="steps" style={{ marginTop: 18 }}>
              <li className="done">ORBIT is running on this laptop.</li>
              <li>On your iPad, open the address above in Safari.</li>
              <li>Scan the QR code — it carries the code, so pairing starts by itself.</li>
              <li>That is it — the iPad shows a standby clock, and the camera starts for gestures.</li>
            </ol>

            {certUrl && (
              <p className="note" style={{ marginTop: 12 }}>
                If the iPad loads the page but cannot connect, install the certificate once:{' '}
                <span className="val">{certUrl}</span> → then Settings → General → About →
                Certificate Trust Settings → turn on “ORBIT Local CA”.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>What happens, and what does not</h2>
        <ul className="list-plain">
          <li>Connecting starts the camera and puts the iPad on a standby clock. Nothing is pushed to it yet.</li>
          <li>Pick a window on the Workspace tab, grab it with a fist, then open your hand while looking at the iPad to send it over.</li>
          <li>Open your hand while looking at the laptop and nothing moves — the window stays where it is.</li>
          <li>Closing a panel stops sharing that window — it never closes the application.</li>
          <li>No file deletion, and no access to passwords, banking, private mail or credentials.</li>
        </ul>
      </div>
    </>
  );
}

/**
 * Plain-HTTP URL that serves the local CA, derived from the receiver URL.
 *
 * It must be HTTP: the HTTPS side is exactly what Safari may be refusing to
 * trust. The port matches the server's default plain-HTTP helper port.
 */
function pairingCertUrl(receiverUrl: string | undefined): string | null {
  if (!receiverUrl) return null;
  try {
    const url = new URL(receiverUrl);
    return `http://${url.hostname}:8788/cert`;
  } catch {
    return null;
  }
}
