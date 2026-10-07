import type { ProviderStatus, OnboardingResult } from "@ace/protocol";

const installs = {
  codex: [
    "npm install -g @openai/codex",
    "Install Codex CLI, then sign in with your ChatGPT account.",
  ],
  claude: [
    "npm install -g @anthropic-ai/claude-code",
    "Install Claude Code, then sign in with your Claude account.",
  ],
  opencode: ["npm install -g opencode-ai", "Install OpenCode, then connect an upstream provider."],
  pi: [
    "npm install -g @mariozechner/pi-coding-agent",
    "Install Pi, then run /login to connect a provider.",
  ],
  cursor: ["", "Install the supported Cursor SDK runtime, then sign in to Cursor in Settings."],
  antigravity: ["", "Install Antigravity from its official provider instructions."],
  acp: ["", "Install and configure an approved ACP agent in Settings."],
} satisfies Record<ProviderStatus["provider"], readonly string[]>;
export function providerReadiness(row: ProviderStatus): ProviderStatus {
  const [installCommand, installHint] =
    row.runtime === "cursor-sdk"
      ? ["", "Install the supported Cursor SDK runtime, then sign in to Cursor in Settings."]
      : installs[row.provider];
  let readiness: NonNullable<ProviderStatus["readiness"]> =
    row.enabled === false
      ? "not_configured"
      : row.installed === false
        ? row.runtime === "cursor-sdk"
          ? "not_configured"
          : "not_installed"
        : // A CLI that doesn't report its sign-in (`auth: "unknown"`) is not a problem: it
          // counts as signed in, and clients say from `auth` that the CLI didn't confirm it.
          row.readiness === "needs_attention" || row.installed === null || row.error
          ? "needs_attention"
          : row.auth === "logged_out" && !(row.provider === "opencode" && row.modelsAvailable)
            ? "installed_signed_out"
            : "signed_in";
  if (row.enabled !== false && row.installed === true && row.state === "not_configured")
    readiness = "installed_signed_out";
  return {
    ...row,
    readiness,
    ...(row.provider === "cursor" && readiness === "installed_signed_out"
      ? { loginHint: "Sign in to Cursor", actionId: "provider.sign_in" as const }
      : {}),
    installHint,
    ...(installCommand ? { installCommand } : {}),
  };
}
/** Cursor has one SDK runtime; legacy CLI rows cannot make it appear ready. */
export function onboardingChecklist(
  rows: readonly ProviderStatus[],
): Pick<Extract<OnboardingResult["result"], { ok: true }>, "providers" | "ready" | "next"> {
  const effective = new Map<ProviderStatus["provider"], ProviderStatus>();
  for (const row of rows) {
    if (row.provider === "cursor" && row.runtime !== "cursor-sdk") continue;
    effective.set(row.provider, providerReadiness(row));
  }
  const providers = [...effective.values()];
  const ready = providers.filter((row) => row.readiness === "signed_in").map((row) => row.provider);
  if (ready.length) return { providers, ready, next: { action: "start_thread" } };
  const signedOut = providers.find(
    (row) =>
      row.readiness === "installed_signed_out" ||
      (row.installed === true && row.readiness === "needs_attention" && row.auth === "logged_out"),
  );
  if (signedOut)
    return { providers, ready, next: { action: "sign_in", provider: signedOut.provider } };
  if (providers.some((row) => row.refreshing || row.installed === null))
    return { providers, ready, next: { action: "refresh" } };
  const installed = providers.find((row) => row.installed === true);
  return {
    providers,
    ready,
    next: installed
      ? { action: "configure", provider: installed.provider }
      : { action: "install", provider: "codex" },
  };
}
