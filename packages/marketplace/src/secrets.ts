import type { MarketProblem } from "@ace/protocol/marketplace";

/*
 * Secrets never travel in an entry (ADR 0168 §5, §7): values shaped like keys and tokens, files
 * named like credentials, and in a recipe any field named like a secret. Each finding is a
 * problem with its line, and any finding refuses the version whole.
 */

const valuePatterns: readonly { label: string; pattern: RegExp }[] = [
  { label: "a private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { label: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    label: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  { label: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    label: "a Slack webhook",
    pattern: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
  },
  { label: "an API key", pattern: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{24,}\b/ },
  { label: "a Stripe key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    label: "a signed token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/,
  },
  { label: "a password in an address", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i },
];

const secretFiles = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)credentials(?:\.json)?$/,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/,
];

/** A field name that reads as a secret: `token`, `apiKey`, `webhook_secret`, `password`, … */
export const secretName =
  /(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|authorization|cookie|session[_-]?id)/i;

export function secretFileProblem(path: string): MarketProblem | undefined {
  return secretFiles.some((pattern) => pattern.test(path))
    ? { path, message: `${path} is named like a credential file; secrets never travel in an entry` }
    : undefined;
}

/** Every line of `text` holding a value shaped like a secret. */
export function secretValueProblems(text: string, path: string): MarketProblem[] {
  const problems: MarketProblem[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries())
    for (const { label, pattern } of valuePatterns)
      if (pattern.test(line)) {
        problems.push({
          path,
          line: index + 1,
          message: `Line ${index + 1} holds what looks like ${label}`,
        });
        if (problems.length >= 50) return problems;
        break;
      }
  return problems;
}

/** Field names anywhere in a JSON value that read as secrets, by their dotted path. */
export function secretFieldNames(value: unknown, at = ""): string[] {
  const found: string[] = [];
  const walk = (item: unknown, path: string) => {
    if (Array.isArray(item)) {
      for (const [index, entry] of item.entries()) walk(entry, `${path}[${index}]`);
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      const named = `${path}${path ? "." : ""}${key}`;
      if (secretName.test(key)) found.push(named);
      walk(entry, named);
    }
  };
  walk(value, at);
  return found;
}
