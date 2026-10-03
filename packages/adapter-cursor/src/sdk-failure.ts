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
