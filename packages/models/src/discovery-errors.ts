import type { ModelDiscoveryError } from "@ace/protocol";
import { z } from "zod";

const messages: Record<ModelDiscoveryError["code"], [string, string]> = {
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
): ModelDiscoveryError {
  const diagnostic = z.object({ message: z.string().optional() }).safeParse(error);
  const text =
    error instanceof Error
      ? error.message
      : diagnostic.success
        ? (diagnostic.data.message ?? "")
        : "";
  const status = z
    .object({ status: z.number().optional(), statusCode: z.number().optional() })
    .safeParse(error);
  const code = status.success ? (status.data.status ?? status.data.statusCode) : undefined;
  const kind =
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    /parse.failure|unreadable.*metadata/i.test(text)
      ? "parse_failure"
      : code === 401 ||
          code === 403 ||
          /\b(?:401|403|unauthorized|authentication|auth.expired)\b/i.test(text)
        ? "auth_expired"
        : code === 429 || /rate.limit|\b429\b/i.test(text)
          ? "rate_limited"
          : /unsupported.*version|version.*unsupported|method.*not.*found|cli.*too.old/i.test(text)
            ? "cli_too_old"
            : /ECONN|ENOTFOUND|unreachable|fetch failed|network|offline/i.test(text)
              ? "unreachable"
              : fallback;
  const [message, hint] = messages[kind];
  return Object.freeze({ code: kind, message, hint });
}
