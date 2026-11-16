/** Shared constants for the local deployment. */

export const LAN_PORT_DEFAULT = 8787;

/** The desktop app is a Chromium shell; this identifies it to the server. */
export const DESKTOP_ORIGIN_PORT = 5173;

/**
 * URL scheme for receiver links.
 *
 * iOS Safari needs a secure context for RTCPeerConnection, so links default to
 * https and only fall back when the server is explicitly run without TLS.
 */
export function receiverScheme(): 'https' | 'http' {
  return process.env.ORBIT_NO_TLS === '1' ? 'http' : 'https';
}
