/** OpenCode v2 uses integration IDs as positional targets, with CLI-owned credential entry. */
export const openCodeLoginChoices = [
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "openai", label: "OpenAI / ChatGPT" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "opencode-go", label: "OpenCode Go" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "other", label: "Other provider" },
];

export function openCodeAuthArgs(action: "login" | "logout", upstream?: string): string[] {
  if (upstream && !openCodeLoginChoices.some((choice) => choice.id === upstream))
    throw new Error("Unknown OpenCode integration");
  return ["auth", action, "--standalone", ...(upstream && upstream !== "other" ? [upstream] : [])];
}

export function openCodeAuthSteps(action: "login" | "logout", upstream?: string) {
  const args = openCodeAuthArgs(action, upstream);
  const name = openCodeLoginChoices.find((choice) => choice.id === upstream)?.label;
  return {
    command: ["opencode", ...args].join(" "),
    instruction:
      action === "logout"
        ? "Choose the account to disconnect in the terminal below. ace checks the result when OpenCode finishes."
        : `Follow ${name && upstream !== "other" ? name + "'s" : "your provider's"} sign-in prompts in the terminal below. If a browser opens, finish there and return here. Enter keys or codes only in this terminal; ace checks the result when OpenCode finishes.`,
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
