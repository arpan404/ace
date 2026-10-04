import { createTextRedactor } from "@ace/redaction";
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
  try {
    const value =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Cursor SDK operation failed";
    const bounded = value.length > 65536 ? value.slice(0, 65536).replace(/\S+$/, "") : value;
    // Drop terminal controls without joining potentially secret-bearing fragments.
    const printable = bounded.replace(/(?![\n\t])\p{Cc}/gu, " ").trim();
    if (!printable) return "Cursor SDK error contained no printable details";
    const safe = createTextRedactor({ env })(printable);
    return safe.length > 4096 ? safe.slice(0, 4096) + " [truncated]" : safe;
  } catch {
    return "Cursor SDK error details omitted by redaction";
  }
}
