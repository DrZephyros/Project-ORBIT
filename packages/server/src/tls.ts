import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type * as ForgeNS from 'node-forge';
import { lanAddress } from './net.js';

// `node-forge` is CommonJS-only; this module is ESM.

/**
 * TLS for the local receiver.
 *
 * iOS Safari only exposes RTCPeerConnection and crypto.randomUUID in a secure
 * context, and a LAN IP over plain HTTP is not one. It also treats a self-signed
 * certificate differently for the page load and for the WebSocket upgrade: the
 * page can load after the per-site warning while `wss://` still fails. That is
 * the "the page opens, but ORBIT cannot reach the laptop" failure.
 *
 * So we generate a tiny local CA and a server certificate signed by it:
 *   - the server serves the leaf + CA chain,
 *   - `/cert` hands the iPad the CA, which it installs as a trusted root,
 *   - once trusted, both the page and the socket work without a warning.
 *
 * The CA is long lived and kept across restarts. Only the leaf is regenerated
 * when DHCP moves the laptop, so an iPad that trusted the CA stays trusted.
 */

export interface Certificate {
  /** Server (leaf) private key. */
  key: string;
  /** Leaf certificate followed by the CA, i.e. the TLS chain. */
  cert: string;
  /** CA certificate in PEM form (for logs/tools). */
  ca: string;
  /**
   * CA certificate in DER form.
   *
   * iOS installs a DER-encoded certificate most reliably, and Safari offers the
   * "Profile Downloaded" flow for it. PEM is kept for humans and scripts.
   */
  caDer: Buffer;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Long enough that the user installs the profile once. */
const CA_DAYS = 3650;
/** Leafs are short lived; they are re-signed automatically by the same CA. */
const LEAF_DAYS = 825;

let cached: Certificate | null = null;

/** Directory that holds the generated certificate. */
export function certDir(): string {
  return process.env.ORBIT_CERT_DIR ?? join(homedir(), '.orbit');
}

function caKeyPath(): string {
  return join(certDir(), 'ca.key.pem');
}

function caCertPath(): string {
  return join(certDir(), 'ca.cert.pem');
}

function keyPath(): string {
  return join(certDir(), 'receiver.key.pem');
}

function certPath(): string {
  return join(certDir(), 'receiver.cert.pem');
}

/** True when a server certificate already exists on disk. */
export function hasCertificate(): boolean {
  return existsSync(keyPath()) && existsSync(certPath());
}

type Forge = typeof import('node-forge');

function forgeModule(): Forge {
  // Resolved lazily so a plain-HTTP run (ORBIT_NO_TLS=1) never loads it.
  return createRequire(import.meta.url)('node-forge') as Forge;
}

export function ensureCertificate(): Certificate {
  if (cached) return cached;

  const forge = forgeModule();
  const { caKey, caCert } = loadOrCreateCa(forge);
  const caPem = forge.pki.certificateToPem(caCert);
  const leaf = loadOrCreateLeaf(forge, caKey, caCert, caPem);

  cached = {
    key: forge.pki.privateKeyToPem(leaf.key),
    cert: `${forge.pki.certificateToPem(leaf.cert).trimEnd()}\n${caPem}`,
    ca: caPem,
    caDer: Buffer.from(new X509Certificate(caPem).raw),
  };
  return cached;
}

interface CaIdentity {
  caKey: ForgeNS.pki.rsa.PrivateKey;
  caCert: ForgeNS.pki.Certificate;
}

function loadOrCreateCa(forge: Forge): CaIdentity {
  if (existsSync(caKeyPath()) && existsSync(caCertPath())) {
    try {
      const caKey = forge.pki.privateKeyFromPem(readFileSync(caKeyPath(), 'utf8')) as ForgeNS.pki.rsa.PrivateKey;
      const caCert = forge.pki.certificateFromPem(readFileSync(caCertPath(), 'utf8'));
      if (caCert.validity.notAfter.getTime() > Date.now() + 30 * DAY_MS) {
        return { caKey, caCert };
      }
      process.stderr.write('[orbit] local CA expired; generating a new one\n');
    } catch {
      process.stderr.write('[orbit] local CA was unreadable; generating a new one\n');
    }
  }
  return generateCa(forge);
}

function generateCa(forge: Forge): CaIdentity {
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serialNumber(forge);
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * DAY_MS);

  const attrs: ForgeNS.pki.CertificateField[] = [
    { name: 'commonName', value: 'ORBIT Local CA' },
    { name: 'organizationName', value: 'ORBIT' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    // iOS only offers a certificate in "Certificate Trust Settings" when it is
    // marked as a CA, so this bit is what makes the iPad install work at all.
    { name: 'basicConstraints', cA: true, critical: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());

  mkdirSync(certDir(), { recursive: true });
  writeFileSync(caKeyPath(), forge.pki.privateKeyToPem(privateKey), { mode: 0o600 });
  writeFileSync(caCertPath(), forge.pki.certificateToPem(cert), { mode: 0o600 });
  return { caKey: privateKey, caCert: cert };
}

function loadOrCreateLeaf(
  forge: Forge,
  caKey: ForgeNS.pki.rsa.PrivateKey,
  caCert: ForgeNS.pki.Certificate,
  caPem: string,
): { key: ForgeNS.pki.rsa.PrivateKey; cert: ForgeNS.pki.Certificate } {
  if (existsSync(keyPath()) && existsSync(certPath())) {
    try {
      const key = forge.pki.privateKeyFromPem(readFileSync(keyPath(), 'utf8')) as ForgeNS.pki.rsa.PrivateKey;
      const cert = forge.pki.certificateFromPem(readFileSync(certPath(), 'utf8'));
      if (leafUsable(forge.pki.certificateToPem(cert), caPem)) {
        return { key, cert };
      }
      // The certificate was generated for an earlier DHCP lease, or signed by a
      // CA that no longer exists. Safari loads the page after the warning but
      // refuses the WSS upgrade, which the user sees as "cannot reach the
      // laptop" even though the page itself opened.
      process.stderr.write(
        `[orbit] re-signing the receiver certificate for ${lanAddress()}\n`,
      );
    } catch {
      process.stderr.write('[orbit] cached certificate was unreadable; generating a new one\n');
    }
  }
  return generateLeaf(forge, caKey, caCert);
}

function generateLeaf(
  forge: Forge,
  caKey: ForgeNS.pki.rsa.PrivateKey,
  caCert: ForgeNS.pki.Certificate,
): { key: ForgeNS.pki.rsa.PrivateKey; cert: ForgeNS.pki.Certificate } {
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serialNumber(forge);
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * DAY_MS);

  const ip = lanAddress();
  cert.setSubject([{ name: 'commonName', value: ip }]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames: { type: number; ip?: string; value?: string }[] = [
    { type: 7, ip: '127.0.0.1' }, // IP address
    { type: 2, value: 'localhost' }, // DNS
  ];
  // Only add the LAN IP when it is a real address, so generation never fails.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1') {
    altNames.unshift({ type: 7, ip });
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  mkdirSync(certDir(), { recursive: true });
  writeFileSync(keyPath(), forge.pki.privateKeyToPem(privateKey), { mode: 0o600 });
  writeFileSync(certPath(), forge.pki.certificateToPem(cert), { mode: 0o600 });
  return { key: privateKey, cert };
}

/**
 * True when a cached leaf is still issued by the current CA and covers the
 * current LAN address.
 *
 * The certificate is issued once and cached so the iPad only accepts the Safari
 * warning a single time. But DHCP moves the laptop, and a certificate whose SAN
 * names the old address breaks the WebSocket handshake without breaking the
 * page load — the worst possible failure shape, because the UI looks reachable
 * and the receiver reports that it cannot reach the laptop.
 */
function leafUsable(leafPem: string, caPem: string): boolean {
  try {
    const leaf = new X509Certificate(leafPem);
    const ca = new X509Certificate(caPem);
    // Renew a little before expiry so a restart never lands on an expired leaf.
    if (Date.parse(leaf.validTo) <= Date.now() + 7 * DAY_MS) return false;
    // A leaf signed by an older CA is useless to an iPad that trusts the new one.
    if (!leaf.checkIssued(ca)) return false;
    if (!leaf.verify(ca.publicKey)) return false;

    const ip = lanAddress();
    if (ip === '127.0.0.1') return true; // No LAN address to validate against.
    return Boolean(leaf.subjectAltName?.includes(`IP Address:${ip}`));
  } catch {
    return false;
  }
}

function serialNumber(forge: Forge): string {
  // 16 random bytes, never starting with a high bit so the DER integer stays
  // positive. Forge treats the string as hex.
  const bytes = forge.random.getBytesSync(16);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return `00${hex}`;
}
