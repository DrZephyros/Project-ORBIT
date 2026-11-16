import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { LAN_PORT_DEFAULT, receiverScheme } from './config.js';
import { OrbitHub } from './hub.js';
import { lanAddress } from './net.js';
import { ensureCertificate, hasCertificate } from './tls.js';

/**
 * ORBIT local server.
 *
 * Serves the receiver web app and hosts the signalling WebSocket. No auth
 * secret ever reaches the receiver: the pairing code is exchanged once over the
 * socket and immediately burned.
 */

const port = Number(process.env.ORBIT_PORT ?? LAN_PORT_DEFAULT);
const host = process.env.ORBIT_BIND ?? '0.0.0.0';
/** Plain-HTTP helper port: desktop signalling socket + certificate download. */
const httpPort = Number(process.env.ORBIT_HTTP_PORT ?? 8788);

/**
 * Resolve the built receiver app relative to this file, not the caller's cwd.
 * Launching from the repo root used to point one directory too high, so `/r`
 * 404'd and the iPad got a blank page.
 */
const here = dirname(fileURLToPath(import.meta.url));
const receiverDist = resolve(here, '../../receiver/dist');

/**
 * iOS Safari refuses RTCPeerConnection and crypto.randomUUID outside a secure
 * context, and the receiver needs both. Plain HTTP on a LAN IP is not a secure
 * context, so the server serves HTTPS with a local self-signed certificate.
 * Set ORBIT_NO_TLS=1 to force plain HTTP (desktop-only debugging).
 */
const useTls = process.env.ORBIT_NO_TLS !== '1';
const scheme = useTls ? 'https' : 'http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Security headers. The iPad runs its own hand/face tracker, so camera
  // access is allowed for this origin and nothing else. Gestures never leave
  // the device: only the resulting pointer and gaze booleans are sent.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'microphone=(self), camera=(self), geolocation=(), payment=(), usb=()',
  );

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 1, host: lanAddress(), port }));
    return;
  }

  // The CA is public material and this route exists to make it easy to install
  // on the iPad. Safari can load the page through a per-site warning and still
  // refuse the WSS upgrade; trusting the CA in iOS Settings removes that whole
  // class of "the page opens but it cannot reach the laptop".
  if (useTls && url.pathname === '/cert') {
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="orbit-ca.cer"',
      'cache-control': 'no-store',
    });
    res.end(ensureCertificate().caDer);
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(302, { location: '/r' });
    res.end();
    return;
  }

  // Static receiver app. Only the receiver route prefix and the MediaPipe
  // runtime/models it loads are exposed.
  const isAsset = url.pathname.startsWith('/assets/');
  const isMediapipe = url.pathname.startsWith('/mediapipe/');
  const isStatic = isAsset || isMediapipe;
  const isReceiverRoute = url.pathname === '/r' || url.pathname.startsWith('/r/');
  if (!isStatic && !isReceiverRoute) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const rel = isStatic ? url.pathname.replace(/^\//, '') : 'index.html';
  const filePath = safeJoin(receiverDist, rel);
  if (!filePath) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      // Hashed asset names are immutable; the MediaPipe runtime and models are
      // versioned by the build and can be cached for a day; the shell must
      // always revalidate.
      'cache-control': isAsset
        ? 'public, max-age=31536000, immutable'
        : isMediapipe
          ? 'public, max-age=86400'
          : 'no-store',
    });
    res.end(body);
  } catch {
    if (existsSync(join(receiverDist, 'index.html')) && !isStatic) {
      // SPA fallback for receiver routes.
      const body = await readFile(join(receiverDist, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(
      'Receiver app not built yet. Run `npm run dev:receiver` (or `npm run build -w @orbit/receiver`).',
    );
  }
};

const hadCertificate = hasCertificate();
const tls = useTls ? ensureCertificate() : null;
const server: Server = tls
  ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler)
  : createHttpServer(handler);

/**
 * Plain-HTTP helper on its own port.
 *
 * Two jobs:
 *  1. Redirect browser visits to HTTPS, because Safari turns a bare
 *     `192.168.8.201:8787` into `http://` and a TLS-only listener resets that.
 *  2. Host a loopback signalling WebSocket for the desktop app, which speaks
 *     `ws://127.0.0.1` and cannot simply trust a self-signed certificate.
 *
 * Windows cannot bind HTTP and HTTPS to the same port (EADDRINUSE), which is
 * why this is a separate port rather than a second protocol on 8787.
 */
function startRedirect(): Server | null {
  if (!tls) return null;
  const redirectPort = httpPort;
  if (redirectPort === port) return null; // Configuration would clash.

  const redirect = createHttpServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    // Serve the CA over plain HTTP on purpose. This is the one thing the iPad
    // may need *before* it can trust the HTTPS side; redirecting it into the
    // very TLS connection that is failing would be a dead end.
    if (pathname === '/cert') {
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="orbit-ca.cer"',
        'cache-control': 'no-store',
      });
      res.end(ensureCertificate().caDer);
      return;
    }

    const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
    const target = `https://${hostHeader || lanAddress()}:${port}${req.url ?? '/r'}`;
    res.writeHead(308, { location: target, 'cache-control': 'no-store' });
    res.end();
  });
  redirect.on('clientError', (_err, socket) => socket.destroy());
  redirect.on('error', (err: NodeJS.ErrnoException) => {
    // Do not fail silently. The desktop's signalling socket defaults to this
    // port; if someone else owns it, the desktop and the iPad end up talking to
    // different hubs, which presents as a pairing code that never matches.
    process.stderr.write(
      `  warn : plain HTTP port ${redirectPort} is unavailable (${err.code ?? 'error'}). ` +
        'The desktop signalling socket lives there, so close whatever owns that port and restart ORBIT.\n',
    );
  });

  redirect.listen(redirectPort, host, () => {
    process.stdout.write(
      `  http  : http://${lanAddress()}:${redirectPort}/r redirects to https\n` +
        `  ws    : ws://127.0.0.1:${redirectPort}/ws for the desktop app\n`,
    );
  });

  return redirect;
}

const hub = new OrbitHub([server], port);

let redirectServer: Server | null = null;

server.listen(port, host, () => {
  redirectServer = startRedirect();
  // The plain-HTTP port also carries a signalling socket for the desktop app.
  // Attaching it to the existing hub keeps one shared session registry.
  if (redirectServer) hub.attach(redirectServer);
  const ip = lanAddress();
  process.stdout.write(
    [
      '',
      '  ORBIT signalling server',
      `  local : ${scheme}://localhost:${port}/r`,
      `  ipad  : ${scheme}://${ip}:${port}/r`,
      tls && !hadCertificate
        ? '  tls   : local certificate generated — accept the Safari warning once'
        : '',
      tls ? '  note  : the iPad must use https:// — plain http:// is redirected automatically' : '',
      tls ? `  trust : install http://${ip}:${httpPort}/cert on the iPad if the socket cannot connect` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  // A newly generated certificate is on disk now, so the banner above is the
  // only time the warning hint can appear.
});

function shutdown(): void {
  hub.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function safeJoin(root: string, rel: string): string | null {
  const target = normalize(join(root, rel));
  const rootNorm = normalize(root);
  return target.startsWith(rootNorm) ? target : null;
}
