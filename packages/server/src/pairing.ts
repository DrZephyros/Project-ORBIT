import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Pairing codes are short, human-typed and short-lived.
 * We never compare them with `===` on untrusted input to keep timing flat,
 * and we store only the hash so a memory dump does not leak live codes.
 */

export const CODE_LENGTH = 6;
/** Digits only: fastest to type on an iPad keyboard, no I/O/0/1 confusion. */
const ALPHABET = '0123456789';

export interface PairingCode {
  code: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

export function generateCode(ttlMs: number, now = Date.now()): PairingCode {
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return {
    code,
    hash: hashCode(code),
    createdAt: now,
    expiresAt: now + ttlMs,
    attempts: 0,
  };
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code.normalize('NFKC').replace(/\s+/g, ''), 'utf8').digest('hex');
}

export type CodeCheck =
  | { ok: true; burned: boolean }
  | { ok: false; reason: 'expired' | 'mismatch' | 'locked' };

/**
 * Single-use semantics: a successful check returns `burned: true`, and the
 * caller must drop the code. Failed attempts are counted so a receiver cannot
 * brute-force a six digit code during its window.
 */
export function checkCode(record: PairingCode, input: string, now = Date.now()): CodeCheck {
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (now > record.expiresAt) return { ok: false, reason: 'expired' };

  const expected = Buffer.from(record.hash, 'utf8');
  const actual = Buffer.from(hashCode(input), 'utf8');
  const equal = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!equal) {
    record.attempts += 1;
    return { ok: false, reason: record.attempts >= MAX_ATTEMPTS ? 'locked' : 'mismatch' };
  }
  return { ok: true, burned: true };
}
