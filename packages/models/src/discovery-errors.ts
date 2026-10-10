import type { ModelDiscoveryError } from "@ace/protocol";
import { discoveryFailureCode } from "@ace/provider-kit/discovery-failure";

const messages: Record<ModelDiscoveryError["code"], [string, string]> = {
  not_installed: ["OpenCode v2 is not installed.", "Install OpenCode v2, then refresh models."],
  no_models: [
    "The connected source has no chat models enabled.",
    "Enable models for it in OpenCode, then Refresh.",
  ],
  not_configured: ["Provider is not configured.", "Set up the provider, then refresh models."],
  auth_expired: [
    "Provider sign-in has expired.",
    "Sign in again using the provider CLI, then refresh models.",
  ],
  unreachable: [
    "Provider could not be reached.",
    "Check the provider endpoint and network, then refresh models.",
  ],
  cli_too_old: [
    "The installed CLI cannot list these models.",
    "Update the provider CLI, then refresh models.",
  ],
  rate_limited: [
    "Provider model discovery was rate limited.",
    "Wait a few minutes, then refresh models.",
  ],
  parse_failure: [
    "Provider returned unreadable model metadata.",
    "Update the CLI and refresh models. Report this if it persists.",
  ],
  timeout: ["Model discovery timed out.", "Check the provider connection, then refresh models."],
  persistence_failed: [
    "The model catalog could not be saved.",
    "Check available disk space and permissions, then refresh models.",
  ],
  discovery_failed: [
    "Model discovery failed.",
    "Check sign-in and the provider CLI, then refresh models.",
  ],
};
/** Inspect diagnostics only to choose a fixed message. Never persist or send their text. */
export function discoveryError(
  error: unknown,
  fallback: ModelDiscoveryError["code"] = "discovery_failed",
  context?: {
    provider: string;
    source?: string;
    backend?: string | undefined;
  },
): ModelDiscoveryError {
  const kind =
    fallback === "no_models" ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "no_models")
      ? "no_models"
      : discoveryFailureCode(error, fallback);
  const [message, hint] = messages[kind];
  const correctiveHint =
    context?.backend === "cursor-sdk" && (kind === "not_configured" || kind === "auth_expired")
      ? kind === "not_configured"
        ? "Sign in to Cursor"
        : "Sign in to Cursor, then refresh models."
      : context?.provider === "opencode" && kind === "auth_expired"
        ? context.source === "github-copilot"
          ? "Reconnect GitHub Copilot in OpenCode (`opencode auth login`), then refresh models."
          : "Reconnect the provider in OpenCode (`opencode auth login`), then refresh models."
        : hint;
  return Object.freeze({
    code: kind,
    ...(kind === "not_installed" ? { severity: "info" as const } : {}),
    ...(kind === "not_configured"
      ? { severity: "info" as const, actionId: "provider.sign_in" as const }
      : {}),
    message:
      kind === "no_models" && context?.source === "github-copilot"
        ? "GitHub Copilot is connected in OpenCode but has no chat models enabled."
        : message,
    hint: correctiveHint,
  });
}
