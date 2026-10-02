import { stripVTControlCharacters } from "node:util";

export type AuthStatus = { auth: "logged_in" | "logged_out" | "unknown"; authDetail?: string };
const unknown: AuthStatus = { auth: "unknown" };

function record(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Unknown CLI output is not evidence of being logged out. */
  }
  return undefined;
}

/** Return only allowlisted auth labels; all identity and credential fields are ignored. */
export function parseClaudeAuth(text: string): AuthStatus {
  const value = record(text);
  if (value?.["loggedIn"] === false) return { auth: "logged_out" };
  if (value?.["loggedIn"] !== true) return unknown;
  const method = value["authMethod"];
  const allowed = ["claude.ai", "api_key", "apiKey", "oauth_token", "bedrock", "vertex", "foundry"];
  return {
    auth: "logged_in",
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

export function parseCursorAuth(text: string): AuthStatus {
  const clean = stripVTControlCharacters(text);
  const value = record(clean);
  if (value?.["isAuthenticated"] === true) return { auth: "logged_in" };
  if (value?.["isAuthenticated"] === false) return { auth: "logged_out" };
  if (/\b(?:not logged in|logged out|not authenticated)\b/i.test(clean))
    return { auth: "logged_out" };
  if (/\blogged in\b/i.test(clean)) return { auth: "logged_in" };
  return unknown;
}

export function parseOpenCodeAuth(text: string): AuthStatus {
  const clean = stripVTControlCharacters(text);
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
    auth: "logged_in",
    authDetail: connected.length ? connected.join(", ") : `${Number(count)} configured credentials`,
  };
}

export function parseVersion(
  provider: "claude" | "codex" | "opencode" | "cursor",
  text: string,
): string | undefined {
  const clean = stripVTControlCharacters(text)
    .trim()
    .replace(/^codex-cli\s+/, "");
  return provider === "cursor"
    ? /^(\d{4}\.\d{2}\.\d{2}-[a-f\d]+)/i.exec(clean)?.[1]
    : /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(clean)?.[1];
}
