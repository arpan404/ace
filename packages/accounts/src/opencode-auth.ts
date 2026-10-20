/**
 * OpenCode v2 uses integration IDs as positional targets, with CLI-owned credential entry. These
 * are offered when OpenCode's server can't list its integrations, and for sign-out.
 */
export const openCodeLoginChoices = [
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "openai", label: "OpenAI / ChatGPT" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "other", label: "Other provider" },
];

const integrationId = /^[a-z0-9_-]{1,64}$/;

/** `opencode auth <action>`, aimed at one integration and method when given. */
export function openCodeAuthArgs(
  action: "login" | "logout",
  integration?: string,
  method?: string,
): string[] {
  if (integration && !integrationId.test(integration))
    throw new Error("Unknown OpenCode integration");
  if (method && !integrationId.test(method)) throw new Error("Unknown OpenCode sign-in method");
  return [
    "auth",
    action,
    "--standalone",
    ...(integration && integration !== "other" ? [integration] : []),
    ...(method ? ["--method", method] : []),
  ];
}

export function openCodeAuthSteps(
  action: "login" | "logout",
  integration?: string,
  method?: string,
  label?: string,
) {
  const args = openCodeAuthArgs(action, integration, method);
  const name = label ?? openCodeLoginChoices.find((choice) => choice.id === integration)?.label;
  return {
    command: ["opencode", ...args].join(" "),
    instruction:
      action === "logout"
        ? "Choose the account to disconnect in the terminal below. ace checks the result when OpenCode finishes."
        : `Follow ${name && integration !== "other" ? name + "'s" : "your provider's"} sign-in prompts in the terminal below. If a browser opens, finish there and return here. Enter keys or codes only in this terminal; ace checks the result when OpenCode finishes.`,
  };
}

/** A saved connection is configuration evidence; this does not promise remote credential validity. */
export function openCodeIntegrationConnected(
  connections: ReadonlyMap<string, number>,
  upstream: string | undefined,
): boolean {
  return upstream && upstream !== "other"
    ? (connections.get(upstream) ?? 0) > 0
    : [...connections.values()].some((count) => count > 0);
}

function totalOpenCodeConnections(connections: ReadonlyMap<string, number>): number {
  return [...connections.values()].reduce((total, count) => total + count, 0);
}

/**
 * Verify an OpenCode account change. Targeted choices check that integration.
 * The untargeted picker checks any connection for login (the CLI's zero exit,
 * gated by the terminal driver, is the change signal) but requires shrinkage
 * for logout so disconnecting one service while another remains still counts.
 */
export function openCodeAuthChangeVerified(
  action: "login" | "logout",
  upstream: string | undefined,
  before: ReadonlyMap<string, number> | undefined,
  after: ReadonlyMap<string, number>,
): boolean {
  if (upstream && upstream !== "other")
    return openCodeIntegrationConnected(after, upstream) === (action === "login");
  if (action === "login") return openCodeIntegrationConnected(after, upstream);
  if (!before) return !openCodeIntegrationConnected(after, upstream);
  return totalOpenCodeConnections(after) < totalOpenCodeConnections(before);
}
