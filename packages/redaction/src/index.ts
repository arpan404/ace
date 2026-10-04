export type RedactionContext = {
  workspace?: string | undefined;
  home?: string | undefined;
  username?: string | undefined;
  host?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

const SECRET_KEY =
  /token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent/i;
const TOKEN_COUNTERS = new Set([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "tokens",
]);
const NATIVE_TOKEN_COUNTERS = new Set(["input", "output", "reasoning", "total"]);
function nonnegativeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nativeTokenCounters(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key, counter]) => {
      if (key !== "cache") return NATIVE_TOKEN_COUNTERS.has(key) && nonnegativeCounter(counter);
      return (
        counter !== null &&
        typeof counter === "object" &&
        !Array.isArray(counter) &&
        Object.entries(counter).every(
          ([name, count]) => (name === "read" || name === "write") && nonnegativeCounter(count),
        )
      );
    })
  );
}
function accountingCounter(key: string, value: unknown): boolean {
  return (
    (TOKEN_COUNTERS.has(key) && nonnegativeCounter(value)) ||
    (key === "tokens" && nativeTokenCounters(value))
  );
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

// These values describe runtime operation, not identity or authentication.
const OPERATIONAL_ENV = new Set([
  "ACE_LOG_LEVEL",
  "LOG_LEVEL",
  "NODE_ENV",
  "DEBUG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
]);
function sensitiveEnvironment(ctx: RedactionContext): Array<[string, string]> {
  return Object.entries(ctx.env ?? {}).filter(
    (entry): entry is [string, string] => Boolean(entry[1]) && !OPERATIONAL_ENV.has(entry[0]),
  );
}

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS: readonly RegExp[] = [
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
];
/** JSON string fields that identify a device, account or organisation. */
const IDENTIFYING_KEYS =
  /"(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)":"[^"]*"/g;
const KEEP_EMAILS = new Set(["recorder@ace.invalid", "noreply@anthropic.com"]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lexical rules are shared by literal diagnostics and recursive JSON redaction. */
function createLexicalRedactor(ctx: RedactionContext): (text: string) => string {
  const home = ctx.home ?? "";
  const username = ctx.username ?? "";
  const host = ctx.host ?? "";
  const shortHost = host.split(".")[0] ?? host;
  // Longest first so the workspace path wins over its home-directory prefix.
  const paths: Array<[RegExp, string]> = [
    [new RegExp(escape(ctx.workspace ?? ""), "g"), "<WORKSPACE>"],
    // Claude encodes paths as directory names by replacing "/" with "-".
    [new RegExp(escape((ctx.workspace ?? "").replaceAll("/", "-")), "g"), "-<WORKSPACE>"],
    [new RegExp(escape(home), "g"), "<HOME>"],
    [new RegExp(escape(host), "g"), "<HOST>"],
    [new RegExp(escape(shortHost), "g"), "<HOST>"],
  ];
  const user = username.length >= 3 ? new RegExp(`\\b${escape(username)}\\b`, "g") : undefined;

  const environmentValues = sensitiveEnvironment(ctx);
  const shortValues = new Set(
    environmentValues.map(([, value]) => value).filter((value) => value.length < 4),
  );
  const values = [
    ...new Set(
      environmentValues
        .filter(([key, value]) => value.length >= 4 || isSecretKey(key))
        .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].toSorted((a, b) => b.length - a.length);
  const environment = values.length ? new RegExp(values.map(escape).join("|"), "g") : undefined;
  return (line: string): string => {
    if (shortValues.has(line)) return "<ENV>";
    let out = line;
    for (const [pattern, replacement] of paths) {
      if (pattern.source !== "(?:)") out = out.replace(pattern, replacement);
    }
    out = out.replace(/(\bfile:\/\/[^/\s"'<>]*)\/(?:Users|home)\/[^/\s"'<>?#]+/gi, "$1<HOME>");
    out = out.replace(/(?<![\w./\\-])\/(?:Users|home)\/[^/\s"'<>]+/g, "<HOME>");
    out = out.replace(/\/(?:private\/)?var\/folders\/[^/\s"'<>]+\/[^/\s"'<>]+\/[TC]\//g, "<TEMP>/");
    if (environment) out = out.replace(environment, "<ENV>");
    out = out.replace(/([#&](?:code|ticket|token)=)[^&#\s]+/gi, "$1<SECRET>");
    for (const pattern of SECRETS) out = out.replace(pattern, "<SECRET>");
    out = out.replace(
      /("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)[^"\n]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"<SECRET>"',
    );
    out = out.replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "<SECRET>");
    out = out.replace(IDENTIFYING_KEYS, (_match, key: string) => `"${key}":"<ID>"`);
    out = out.replace(EMAIL, (match) => (KEEP_EMAILS.has(match) ? match : "<EMAIL>"));
    if (user) out = out.replace(user, "<USER>");
    return out;
  };
}

/** Literal prose has no JSON transport keys to collide with environment values. */
export function createTextRedactor(ctx: RedactionContext): (text: string) => string {
  const omitted = "<REDACTION FAILED: TEXT OMITTED>";
  try {
    const scrub = createLexicalRedactor(ctx);
    return (text) => {
      if (text.length > 65536) return "<OVERSIZED REDACTED>";
      try {
        const safe = scrub(text);
        return safe.length > 262144 ? "<OVERSIZED REDACTED>" : safe;
      } catch {
        return omitted;
      }
    };
  } catch {
    return () => omitted;
  }
}

/** Build a redactor that scrubs one JSONL line of personal or secret data. */
export function createRedactor(
  ctx: RedactionContext,
  literalTextFields: readonly string[] = [],
): (line: string) => string {
  const literalFields = new Set(literalTextFields);
  const scrub = createLexicalRedactor(ctx);
  const identity =
    /^(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)$/;
  return (line) => {
    if (line.length > 262144) return '"<OVERSIZED REDACTED>"';
    let remaining = 10000;
    function clean(value: unknown, depth: number, field?: string): unknown {
      if (--remaining < 0 || depth > 32) return "<OMITTED>";
      if (typeof value === "string") {
        if (field !== undefined && literalFields.has(field)) return scrub(value);
        const text = value.trimStart();
        if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
          try {
            const embedded: unknown = JSON.parse(value);
            return JSON.stringify(clean(embedded, depth + 1));
          } catch {
            return "<INVALID STRUCTURED DATA OMITTED>";
          }
        }
        return scrub(value);
      }
      if (Array.isArray(value))
        return value.slice(0, remaining).map((item) => clean(item, depth + 1));
      if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          if (remaining <= 0) break;
          Object.defineProperty(result, scrub(key), {
            enumerable: true,
            configurable: true,
            writable: true,
            value:
              isSecretKey(key) && !accountingCounter(key, item)
                ? "<SECRET>"
                : identity.test(key)
                  ? "<ID>"
                  : clean(item, depth + 1, key),
          });
        }
        return result;
      }
      return value;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A damaged structured record must never fall back to weaker lexical rules.
      if (/^\s*[[{"]/.test(line)) return '"<INVALID STRUCTURED DATA OMITTED>"';
      return scrub(line);
    }
    try {
      return JSON.stringify(clean(value, 0));
    } catch {
      return '"<REDACTION FAILED: RECORD OMITTED>"';
    }
  };
}

/** Preserve token matches across bounded chunks without rescanning the remaining text. */
export function createStreamingRedactor(ctx: RedactionContext): (text: string) => Iterable<string> {
  const scrub = createTextRedactor(ctx);
  const values = sensitiveEnvironment(ctx).map(([, value]) => value);
  const sources = [
    ...SECRETS,
    EMAIL,
    IDENTIFYING_KEYS,
    /("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)[^"\n]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
    /([#&](?:code|ticket|token)=)[^&#\s]+/gi,
    ...(values.length ? [new RegExp(values.map(escape).join("|"), "g")] : []),
  ];
  return function* (text: string) {
    const scans = sources.map((pattern) => {
      const regex = new RegExp(pattern.source, pattern.flags);
      return { regex, match: regex.exec(text) };
    });
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + 4096);
      for (const scan of scans) {
        while (scan.match && scan.match.index + scan.match[0].length <= start)
          scan.match = scan.regex.exec(text);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const scan of scans) {
          while (scan.match && scan.match.index < end) {
            const matchEnd = scan.match.index + scan.match[0].length;
            if (matchEnd > end) {
              end = matchEnd;
              changed = true;
            }
            scan.match = scan.regex.exec(text);
          }
        }
      }
      if (end - start > 65536) throw new Error("Sensitive SDK text exceeds redaction chunk budget");
      const high = text.charCodeAt(end - 1),
        low = text.charCodeAt(end);
      if (end < text.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff)
        end++;
      yield scrub(text.slice(start, end));
      start = end;
    }
  };
}
export function isSensitiveField(key: string, value: unknown): boolean {
  return isSecretKey(key) && !accountingCounter(key, value);
}
