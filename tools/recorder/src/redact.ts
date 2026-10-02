import { homedir, hostname, userInfo } from "node:os";

export type RedactionContext = {
  workspace: string;
  home?: string;
  username?: string;
  host?: string;
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{16,}/g,
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
  const home = ctx.home ?? homedir();
  const username = ctx.username ?? userInfo().username;
  const host = ctx.host ?? hostname();
  const shortHost = host.split(".")[0] ?? host;
  // Longest first so the workspace path wins over its home-directory prefix.
  const paths: Array<[RegExp, string]> = [
    [new RegExp(escape(ctx.workspace), "g"), "<WORKSPACE>"],
    // Claude encodes paths as directory names by replacing "/" with "-".
    [new RegExp(escape(ctx.workspace.replaceAll("/", "-")), "g"), "-<WORKSPACE>"],
    [new RegExp(escape(home), "g"), "<HOME>"],
    [new RegExp(escape(host), "g"), "<HOST>"],
    [new RegExp(escape(shortHost), "g"), "<HOST>"],
  ];
  const user = username.length >= 3 ? new RegExp(`\\b${escape(username)}\\b`, "g") : undefined;

  return (line) => {
    let out = line;
    for (const [pattern, replacement] of paths) out = out.replace(pattern, replacement);
    for (const pattern of SECRETS) out = out.replace(pattern, "<SECRET>");
    out = out.replace(IDENTIFYING_KEYS, (_match, key: string) => `"${key}":"<ID>"`);
    out = out.replace(EMAIL, (match) => (KEEP_EMAILS.has(match) ? match : "<EMAIL>"));
    if (user) out = out.replace(user, "<USER>");
    return out;
  };
}
