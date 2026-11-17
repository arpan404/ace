import type { ProviderStatus } from "@ace/protocol";
import { columns, count } from "./provider-columns.ts";

/**
 * `ace provider list|show|capabilities` for a person (ADR 0176 §3): the provider, its state in
 * words, and what to do when it isn't ready. Pure.
 */

const names: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  acp: "ACP agent",
};

export function providerName(provider: string): string {
  return names[provider] ?? provider;
}

/** The state a person reads, and whether it needs them. */
export function providerState(status: ProviderStatus): { words: string; needsYou: boolean } {
  if (status.enabled === false) return { words: "off", needsYou: false };
  if (status.installed === false || status.readiness === "not_installed")
    return { words: "not installed", needsYou: true };
  if (status.versionCheck?.status === "too_old" || status.readiness === "needs_update")
    return { words: "needs an update", needsYou: true };
  if (status.readiness === "not_configured" || status.state === "not_configured")
    return { words: "not set up", needsYou: true };
  if (status.auth === "logged_out" || status.readiness === "installed_signed_out")
    return { words: "signed out", needsYou: true };
  if (status.readiness === "needs_attention" || status.error)
    return { words: "needs attention", needsYou: true };
  if (status.auth === "logged_in" || status.readiness === "signed_in")
    return { words: "ready", needsYou: false };
  return { words: "checking", needsYou: false };
}

export function providerListLines(value: { providers: readonly ProviderStatus[] }): string[] {
  if (!value.providers.length) return ["No provider CLIs found. Install Codex or Claude Code."];
  return columns(
    value.providers.map((status) => {
      const state = providerState(status);
      return [status.provider, state.words, status.version, status.accountLabel];
    }),
  );
}

/** The next command for a provider that isn't ready, or nothing. */
export function providerNextStep(status: ProviderStatus): string | undefined {
  const { words } = providerState(status);
  if (words === "not installed")
    return status.installCommand ? `Install it: ${status.installCommand}` : status.installHint;
  if (words === "signed out") return `Sign in: ace provider login ${status.provider}`;
  if (words === "needs an update")
    return status.installCommand ? `Update it: ${status.installCommand}` : status.installHint;
  if (words === "needs attention") return status.error ?? status.loginHint;
  return undefined;
}

export function providerShowLines(status: ProviderStatus): string[] {
  const state = providerState(status);
  const rows: [string, string | undefined][] = [
    ["state", state.words],
    ["version", status.version],
    ["latest", status.updateAvailable ? status.latestVersion : undefined],
    ["path", status.path],
    ["account", status.accountLabel],
    ["sign-in", status.authMethod],
    [
      "tools",
      status.nativeTools?.length
        ? status.nativeTools.map((tool) => `${tool.label} ${tool.state}`).join(", ")
        : undefined,
    ],
  ];
  const next = providerNextStep(status);
  return [
    `${providerName(status.provider)} (${status.provider})`,
    ...columns(rows.filter((row) => row[1]).map(([name, value]) => [`  ${name}`, value])),
    ...(next ? ["", next] : []),
  ];
}

/** The capabilities in a few lines; `--json` has every field. */
export function capabilitiesLines(value: {
  providers: readonly ProviderStatus[];
  models: unknown;
  permissions: readonly { provider: string }[];
  tools: unknown;
}): string[] {
  const models = arrayAt(value.models, "models");
  const tools = arrayAt(value.tools, "tools") ?? (Array.isArray(value.tools) ? value.tools : []);
  const perProvider = new Map<string, number>();
  for (const model of models ?? []) {
    const provider = isRecord(model) && typeof model.provider === "string" ? model.provider : "";
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
  }
  return [
    ...columns(
      value.providers.map((status) => [
        status.provider,
        providerState(status).words,
        count(perProvider.get(status.provider) ?? 0, "model"),
        status.permissionModes?.length ? count(status.permissionModes.length, "mode") : undefined,
      ]),
    ),
    "",
    `${count(tools.length, "ace tool")}. Every field: ace provider capabilities --json`,
  ];
}

function arrayAt(value: unknown, key: string): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const inner = value[key];
  if (Array.isArray(inner)) return inner;
  return isRecord(value.result) ? arrayAt(value.result, key) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
