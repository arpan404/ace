import { QUOTED_SECRET_ASSIGNMENT } from "./quoted-assignments.ts";

interface CredentialPattern {
  pattern: RegExp;
  /** Retain syntactic prefixes and quotes around JSON values or URL parameters. */
  prefix?: number;
  suffix?: number;
}

/** Every credential spelling is matched against original text, before env,
 * path or identity replacement can consume its identifying prefix. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  ...[
    /\bAIza[A-Za-z0-9_-]{35}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /\bnpm_[A-Za-z0-9]{20,}/g,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bgh[opsur]_[A-Za-z0-9]{20,}/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi,
    QUOTED_SECRET_ASSIGNMENT,
    /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
  ].map((pattern) => ({ pattern })),
  {
    pattern: /("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)[^"\n]*"\s*:\s*")(?:[^"\\]|\\.)+"/gi,
    prefix: 0,
    suffix: 1,
  },
  { pattern: /([#&](?:code|ticket|token)=)[^&#\s]+/gi, prefix: 0 },
];
