import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import { migratePermissionMode, resolvePermissionMode } from "@ace/provider-kit/permission-modes";
import { permissionOption, type PermissionOption } from "./permissions.ts";
import { providerNames } from "./providers.ts";

const descriptions: Partial<Record<ProviderKind, readonly [string, string, string]>> = {
  claude: [
    "Ask when approval is needed.",
    "Let Claude review requests.",
    "Skip permission checks.",
  ],
  codex: [
    "Read only; ask for approval.",
    "Let Codex review requests.",
    "Allow changes anywhere and network access.",
  ],
  cursor: [
    "Run isolated, without automatic review.",
    "Review requests in isolation.",
    "Skip isolation and automatic review.",
  ],
  opencode: [
    "Ask for actions covered by your rules.",
    "Automatic review is not supported.",
    "Allow actions; rules still apply.",
  ],
};
const presets = [
  { key: "ask", label: "Manual", risk: "low" },
  { key: "auto-review", label: "Auto review", risk: "medium" },
  { key: "full-access", label: "Full access", risk: "high" },
] as const;

/** Only explicit known native selectors become presets; capability flags never invent a mode. */
export function composerPermissionOptions(
  provider: ProviderKind | undefined,
  capabilities: PermissionCapabilities | undefined,
): PermissionOption[] {
  const name = provider ? providerNames[provider] : "This provider";
  return presets.map((preset, index) => {
    const reviewProvider = provider === "claude" || provider === "codex" || provider === "cursor";
    const native =
      provider && (preset.key !== "auto-review" || reviewProvider)
        ? migratePermissionMode(provider, preset.key)
        : null;
    const offered = capabilities?.permissionModes?.find((mode) => mode.id === native);
    const unavailable =
      preset.key === "ask" && capabilities?.toolGate === false
        ? `${name} cannot pause for approvals.`
        : preset.key === "auto-review" && !capabilities?.nativeAutoReview
          ? `${name} does not support native automatic review.`
          : !offered
            ? `${name} does not offer this mode.`
            : undefined;
    return {
      id: offered && !unavailable ? offered.id : `composer:${preset.key}`,
      label: preset.label,
      description:
        (provider && descriptions[provider]?.[index]) ??
        "Use the provider's supported permission mode.",
      risk: preset.risk,
      unavailable,
    };
  });
}

/** Unrecognized saved native modes remain honest in the trigger and never select a preset. */
export function composerPermissionOption(
  provider: ProviderKind | undefined,
  mode: PermissionMode | null,
  capabilities: PermissionCapabilities | undefined,
): PermissionOption {
  if (mode === null)
    return {
      id: "unavailable",
      label: "Permissions unavailable",
      description: "This provider does not offer a supported review or manual mode.",
      risk: "low",
      unavailable: "No supported permission mode is available.",
    };
  return (
    composerPermissionOptions(provider, capabilities).find(
      (option) => option.id === mode && !option.unavailable,
    ) ?? permissionOption(mode, capabilities)
  );
}

export const composerPermissionDefault = resolvePermissionMode;
