import type { ProviderKind } from "@ace/protocol";
import type { LoginUpdate } from "./login-sessions.ts";

/** Only reviewed verification/authorization endpoints may cross the wire. */
export function loginUrl(provider: ProviderKind, candidate: string): string | undefined {
  if (candidate.length > 8192 || /\s/.test(candidate)) return;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) return;
  const allowed =
    provider === "codex"
      ? ([["auth.openai.com", /^\/(?:codex\/device|oauth\/authorize|authorize)\/?$/]] as const)
      : provider === "claude"
        ? ([
            ["claude.ai", /^\/oauth\/authorize\/?$/],
            ["console.anthropic.com", /^\/oauth\/authorize\/?$/],
            ["platform.claude.com", /^\/oauth\/authorize\/?$/],
          ] as const)
        : provider === "cursor"
          ? ([["cursor.com", /^\/(?:login|loginDeepControl)\/?$/]] as const)
          : ([
              ["github.com", /^\/login\/device\/?$/],
              ["auth.openai.com", /^\/codex\/device\/?$/],
            ] as const);
  if (!allowed.some(([host, path]) => url.hostname === host && path.test(url.pathname))) return;
  const fields = new Set([
    ...(provider === "cursor" ? ["challenge", "uuid", "mode", "redirect"] : []),
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "audience",
    "originator",
    "id_token_add_organizations",
    "codex_cli_simplified_flow",
  ]);
  for (const [key, value] of url.searchParams) {
    if (!fields.has(key) || /(?:sk-|ghp_|gho_|eyJ)[A-Za-z0-9_-]{12,}/.test(value)) return;
    if (key === "redirect_uri") {
      let redirect: URL;
      try {
        redirect = new URL(value);
      } catch {
        return;
      }
      if (
        redirect.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
        redirect.username ||
        redirect.password ||
        redirect.search ||
        redirect.hash
      )
        return;
    }
  }
  return url.href;
}

export type LoginObservation = LoginUpdate & { enter?: true; manualRequired?: true };
/** Never relay a raw line, including unknown prompts or errors. */
export function loginObservation(
  provider: ProviderKind,
  text: string,
): LoginObservation | undefined {
  if (
    /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|(?:authorization|oauth) code|paste.*code)/i.test(
      text,
    )
  )
    return /(?:enter|paste|input|provide)|(?:key|token|code)\s*:\s*$/i.test(text)
      ? { state: "awaiting_input", manualRequired: true }
      : undefined;
  // A BEL is a terminal hyperlink terminator, not part of the URL.
  // eslint-disable-next-line no-control-regex
  const match = /https:\/\/[^\s<>"\u0007]+(?=\s|$)/.exec(text);
  const url = match ? loginUrl(provider, match[0]) : undefined;
  const code =
    /(?:user code|device code|enter(?: this| the)? code|code:)\s*[:=]?\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9_-])/i.exec(
      text,
    )?.[1];
  if (url || code)
    return {
      state: code ? "awaiting_code_entry" : "awaiting_browser",
      ...(url ? { url } : {}),
      ...(code ? { userCode: code.toUpperCase() } : {}),
    };
  if (/press (?:enter|return)|hit enter/i.test(text))
    return { state: "awaiting_input", prompt: "Press Enter to continue.", enter: true };
  return;
}
