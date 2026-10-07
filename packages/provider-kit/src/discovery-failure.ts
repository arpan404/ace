import { z } from "zod";

export const DiscoveryFailureCode = z.enum([
  "not_configured",
  "auth_expired",
  "unreachable",
  "cli_too_old",
  "rate_limited",
  "parse_failure",
  "timeout",
  "persistence_failed",
  "discovery_failed",
]);
export type DiscoveryFailureCode = z.infer<typeof DiscoveryFailureCode>;
const shape = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  status: z.number().optional(),
  statusCode: z.number().optional(),
  cause: z.unknown().optional(),
  error: z.unknown().optional(),
  data: z.unknown().optional(),
});
/** Bounded inspection of provider diagnostics. Only a fixed category leaves this function. */
export function discoveryFailureCode(
  error: unknown,
  fallback: DiscoveryFailureCode = "discovery_failed",
): DiscoveryFailureCode {
  const pending: unknown[] = [error];
  let text = "";
  for (let index = 0; index < pending.length && index < 8; index++) {
    const value = pending[index];
    if (value instanceof z.ZodError || value instanceof SyntaxError) return "parse_failure";
    const parsed = shape.safeParse(value);
    if (!parsed.success) continue;
    const detail = parsed.data;
    const explicit = DiscoveryFailureCode.safeParse(detail.code);
    if (explicit.success) return explicit.data;
    const status = detail.status ?? detail.statusCode;
    if (status === 401 || status === 403) return "auth_expired";
    if (status === 429) return "rate_limited";
    if (status !== undefined && status >= 500 && status <= 599) return "unreachable";
    const message = (detail.message ?? "").slice(0, 8192);
    text += ` ${detail.name?.slice(0, 128) ?? ""} ${detail.reason?.slice(0, 128) ?? ""} ${String(detail.code ?? "").slice(0, 128)} ${message}`;
    // JsonRpcPeer preserves the safe host error envelope as its Error message.
    if (message.startsWith("{")) {
      try {
        pending.push(JSON.parse(message));
      } catch {
        /* Plain diagnostic prose. */
      }
    }
    for (const nested of [detail.cause, detail.error, detail.data])
      if (nested !== undefined) pending.push(nested);
  }
  return /not.configured|missing.api.key|no.api.key|not.logged.in/i.test(text)
    ? "not_configured"
    : /authentication|unauthenticated|unauthorized|auth.expired|\b(?:401|403)\b/i.test(text)
      ? "auth_expired"
      : /RateLimitError|rate.limit|\b429\b/i.test(text)
        ? "rate_limited"
        : /parse.failure|unreadable.*metadata|MalformedResponse|UnsupportedContentType/i.test(text)
          ? "parse_failure"
          : /unsupported.*version|version.*unsupported|method.*not.*found|cli.*too.old/i.test(text)
            ? "cli_too_old"
            : /NetworkError|Transport|ECONN|ENOTFOUND|unreachable|fetch failed|network|offline/i.test(
                  text,
                )
              ? "unreachable"
              : fallback;
}
