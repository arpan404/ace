import { z } from "zod";
import { stripVTControlCharacters } from "node:util";

export type AuthStatus = {
  auth: "logged_in" | "logged_out" | "unknown";
  authDetail?: string;
  accountLabel?: string;
  authEvidence?: "credentials_configured";
};
function accountLabel(value: unknown): Pick<AuthStatus, "accountLabel"> {
  const parsed = z.email().max(256).safeParse(value);
  return parsed.success ? { accountLabel: parsed.data } : {};
}
const unknown: AuthStatus = { auth: "unknown" };

function record(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    /* Unknown CLI output is not evidence of being logged out. */
  }
  return undefined;
}

/** Return only allowlisted status and account labels; credential fields are ignored. */
export function parseClaudeAuth(text: string): AuthStatus {
  const value = record(text);
  if (value?.["loggedIn"] === false) return { auth: "logged_out" };
  if (value?.["loggedIn"] !== true) return unknown;
  const method = value["authMethod"];
  const allowed = [
    "claude.ai",
    "api_key",
    "apiKey",
    "api_key_helper",
    "third_party",
    "oauth_token",
    "bedrock",
    "vertex",
    "foundry",
  ];
  return {
    auth: "logged_in",
    ...accountLabel(value["email"]),
    ...(typeof method === "string" && allowed.includes(method) ? { authDetail: method } : {}),
  };
}

export function parseCodexAuth(text: string): AuthStatus {
  const clean = stripVTControlCharacters(text);
  if (/\b(?:not logged in|logged out)\b/i.test(clean)) return { auth: "logged_out" };
  if (!/\blogged in\b/i.test(clean)) return unknown;
  return {
    auth: "logged_in",
    ...(/\bChatGPT\b/i.test(clean)
      ? { authDetail: "ChatGPT" }
      : /\bAPI key\b/i.test(clean)
        ? { authDetail: "API key" }
        : {}),
  };
}

export function parseOpenCodeAuth(text: string): AuthStatus {
  const clean = stripVTControlCharacters(text);
  if (clean.startsWith("[")) {
    try {
      const rows = z
        .array(
          z
            .object({
              id: z.string(),
              connections: z
                .array(z.object({ type: z.enum(["credential", "env"]) }).passthrough())
                .max(128),
            })
            .passthrough(),
        )
        .max(512)
        .parse(JSON.parse(clean));
      const count = rows.reduce((total, row) => total + row.connections.length, 0);
      return count === 0
        ? { auth: "logged_out" }
        : {
            auth: "unknown",
            authEvidence: "credentials_configured",
            authDetail: `${count} configured connections; entitlement unverified`,
          };
    } catch {
      return unknown;
    }
  }
  if (clean === "No authenticated integrations") return { auth: "logged_out" };
  const count = /\b(\d+) credentials?\b/i.exec(clean)?.[1];
  if (count === undefined) return unknown;
  if (Number(count) === 0) return { auth: "logged_out" };
  // Future vendors still count as configured. Never expose arbitrary CLI text.
  const names = [
    "Anthropic",
    "OpenAI",
    "GitHub Copilot",
    "Google",
    "OpenCode Zen",
    "OpenCode Go",
    "LMStudio",
    "Amazon Bedrock",
    "Azure",
    "OpenRouter",
  ];
  const connected = names.filter((name) =>
    clean.split("\n").some((line) => line.includes(`●  ${name} `) || line.includes(`●  ${name}\t`)),
  );
  return {
    auth: "unknown",
    authEvidence: "credentials_configured",
    authDetail: connected.length ? connected.join(", ") : `${Number(count)} configured credentials`,
  };
}

export function parseVersion(
  _provider: "claude" | "codex" | "opencode" | "cursor" | "antigravity",
  text: string,
): string | undefined {
  const clean = stripVTControlCharacters(text)
    .trim()
    .replace(/^(?:codex-cli|agy|antigravity(?: CLI)?)\s+/i, "")
    .replace(/^opencode\s+v?/i, "");
  return /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(clean)?.[1];
}
