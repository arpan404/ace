import { createRedactor } from "@ace/redaction";
import { z } from "zod";
import type { RuntimeSdkBoundary } from "./runtime-boundary.ts";

/** Only SDK classes establish retry/auth state. Provider prose never does. */
export function sdkFailure(
  sdk: RuntimeSdkBoundary,
  error: unknown,
): { code?: string; retryable?: boolean } {
  if (error instanceof sdk.AuthenticationError) return { code: "auth" };
  if (error instanceof sdk.RateLimitError)
    return { code: "rate_limit", retryable: error.isRetryable };
  if (error instanceof sdk.NetworkError) return { code: "network", retryable: error.isRetryable };
  return {};
}

/** Never serialize vendor errors, stacks or causes. Scrub bounded prose before truncating it. */
export function safeCursorErrorMessage(error: unknown, env: NodeJS.ProcessEnv): string {
  const value =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Cursor SDK operation failed";
  const bounded = value.length > 65536 ? value.slice(0, 65536).replace(/\S+$/, "") : value;
  const scrub = createRedactor({ env }, ["text"]);
  const safe = z
    .object({ text: z.string() })
    .parse(JSON.parse(scrub(JSON.stringify({ text: bounded }))));
  return safe.text.length > 4096 ? safe.text.slice(0, 4096) + " [truncated]" : safe.text;
}
