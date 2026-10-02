export type RedactionContext = {
  workspace?: string | undefined;
  home?: string | undefined;
  username?: string | undefined;
  host?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|cookie|credential/i;
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
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
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/g,
];
/** JSON string fields that identify a device, account or organisation. */
const IDENTIFYING_KEYS =
  /"(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)":"[^"]*"/g;
const KEEP_EMAILS = new Set(["recorder@ace.invalid", "noreply@anthropic.com"]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a redactor that scrubs one JSONL line of personal or secret data. */
export function createRedactor(ctx: RedactionContext): (line: string) => string {
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

  const values = [
    ...new Set(
      Object.values(ctx.env ?? {})
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].toSorted((a, b) => b.length - a.length);
  const environment = values.length ? new RegExp(values.map(escape).join("|"), "g") : undefined;
  const scrub = (line: string): string => {
    let out = line;
    for (const [pattern, replacement] of paths) {
      if (pattern.source !== "(?:)") out = out.replace(pattern, replacement);
    }
    if (environment) out = out.replace(environment, "<ENV>");
    for (const pattern of SECRETS) out = out.replace(pattern, "<SECRET>");
    out = out.replace(
      /("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie|credential)[^"\n]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"<SECRET>"',
    );
    out = out.replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "<SECRET>");
    out = out.replace(IDENTIFYING_KEYS, (_match, key: string) => `"${key}":"<ID>"`);
    out = out.replace(EMAIL, (match) => (KEEP_EMAILS.has(match) ? match : "<EMAIL>"));
    if (user) out = out.replace(user, "<USER>");
    return out;
  };
  const identity =
    /^(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)$/;
  function clean(value: unknown): unknown {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(result, scrub(key), {
          enumerable: true,
          value: isSecretKey(key) ? "<SECRET>" : identity.test(key) ? "<ID>" : clean(item),
        });
      }
      return result;
    }
    return value;
  }
  return (line) => {
    try {
      const value: unknown = JSON.parse(line);
      return JSON.stringify(clean(value));
    } catch {
      return scrub(line);
    }
  };
}
