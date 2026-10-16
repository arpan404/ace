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

function configuredServices(count: number): string {
  return `${count} service${count === 1 ? "" : "s"} configured`;
}

/** Only integration IDs and connection counts leave the CLI status boundary. */
export function parseOpenCodeAuthConnections(text: string): Map<string, number> | undefined {
  try {
    const rows = z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          connections: z.array(z.object({ type: z.enum(["credential", "env"]) })).max(128),
        }),
      )
      .max(512)
      .parse(JSON.parse(stripVTControlCharacters(text)));
    return new Map(rows.map((row) => [row.id, row.connections.length]));
  } catch {
    return undefined;
  }
}

export function parseOpenCodeAuth(text: string): AuthStatus {
  const connections = parseOpenCodeAuthConnections(text);
  if (!connections) return unknown;
  const count = [...connections.values()].filter(
    (connectionsForService) => connectionsForService > 0,
  ).length;
  return count === 0
    ? { auth: "logged_out" }
    : {
        auth: "unknown",
        authEvidence: "credentials_configured",
        authDetail: configuredServices(count),
      };
}

export function parseVersion(_provider: string, text: string): string | undefined {
  const clean = stripVTControlCharacters(text)
    .trim()
    .replace(/^(?:codex-cli|agy|antigravity(?: CLI)?)\s+/i, "")
    .replace(
      /^(?:opencode|pi|gemini|qwen|claude-agent-acp|codex-acp|goose|auggie)(?:\s+version)?\s+v?/i,
      "",
    );
  return /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(clean)?.[1];
}
