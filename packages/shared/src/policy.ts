import type { ActionCategory, ActionPolicy, PolicyDecision } from './index.js';

/**
 * Permission policy (Outline section 8).
 *
 * The plan is explicit that we cannot claim "no deletion, no sensitive access"
 * while granting an agent unrestricted input. So the boundary lives here, in
 * one table that every executor must consult, and every action is classified
 * before it runs. Anything unknown is blocked rather than allowed.
 */

const TABLE: Record<ActionCategory, { policy: ActionPolicy; reason: string }> = {
  workspace: { policy: 'allowed', reason: 'Arrange, select and broadcast panels.' },
  apps: { policy: 'allowed', reason: 'Open or switch to a listed, approved application.' },
  browser: { policy: 'allowed', reason: 'Navigate the dedicated automation profile only.' },
  media: { policy: 'allowed', reason: 'Search and control playback in the media panel.' },
  documents: { policy: 'allowed', reason: 'Read only documents the user explicitly approved.' },
  dictation: { policy: 'allowed', reason: 'Insert dictated text into an approved destination.' },
  session: { policy: 'allowed', reason: 'Pause, disconnect and stop are always available.' },
  coding: { policy: 'needs-approval', reason: 'Edits land in an isolated copy and require review.' },
  destructive: { policy: 'blocked', reason: 'Deletion and overwrite of existing files are not permitted.' },
  sensitive: { policy: 'blocked', reason: 'Credentials, banking, private mail and personal documents are out of scope.' },
  shell: { policy: 'blocked', reason: 'No unrestricted shell or arbitrary host scripting.' },
};

export function decide(category: ActionCategory): PolicyDecision {
  const entry = TABLE[category];
  return { category, policy: entry.policy, reason: entry.reason };
}

export function isAllowed(category: ActionCategory): boolean {
  return TABLE[category].policy === 'allowed';
}

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

/**
 * Heuristics used before an action executes. These are a safety net, not a
 * guarantee: isolation is the real boundary (section 8). Anything matched here
 * is surfaced to the user instead of being silently executed.
 */

const SENSITIVE_PATH_PATTERNS = [
  /\\appdata\\(roaming|local)\\(microsoft\\windows\\)?credentials/i,
  /\\appdata\\roaming\\microsoft\\protect/i,
  /\\(\.ssh|\.gnupg|\.aws|\.azure|\.kube)(\\|$)/i,
  /\\(cookies|login data|web data|key4\.db|logins\.json)$/i,
  /\\(passwords?|credentials?|secrets?)(\.\w+)?$/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
  /\.env(\.[\w-]+)?$/i,
];

const SENSITIVE_HOST_PATTERNS = [
  /(^|\.)bank/i,
  /(^|\.)paypal\./i,
  /(^|\.)coinbase\./i,
  /(^|\.)mail\.google\./i,
  /(^|\.)outlook\.(live|office)\./i,
  /(^|\.)1password\./i,
  /(^|\.)lastpass\./i,
  /(^|\.)bitwarden\./i,
  /(^|\.)dashlane\./i,
];

export interface ClassificationResult {
  category: ActionCategory;
  allowed: boolean;
  matched?: string;
}

export function classifyPath(path: string): ClassificationResult {
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return { category: 'sensitive', allowed: false, matched: pattern.source };
    }
  }
  return { category: 'documents', allowed: true };
}

export function classifyHost(host: string): ClassificationResult {
  for (const pattern of SENSITIVE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      return { category: 'sensitive', allowed: false, matched: pattern.source };
    }
  }
  return { category: 'browser', allowed: true };
}

/** Block the verbs that imply deletion, regardless of target. */
const DESTRUCTIVE_VERBS = /\b(delete|remove|erase|wipe|destroy|unlink|rm|rmdir|del|format|truncate)\b/i;

export function classifyIntent(utterance: string): ClassificationResult {
  if (DESTRUCTIVE_VERBS.test(utterance)) {
    return { category: 'destructive', allowed: false, matched: 'destructive-verb' };
  }
  return { category: 'session', allowed: true };
}

/**
 * Untrusted text (page content, repository READMEs, document bodies) must never
 * be able to widen permissions. We keep the signal explicit so callers can
 * refuse to feed it into the planner as instructions.
 */
export function trustBoundary(source: 'user' | 'page' | 'document' | 'repository' | 'model'): boolean {
  return source === 'user' || source === 'model';
}
