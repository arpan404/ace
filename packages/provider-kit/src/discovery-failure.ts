import { z } from "zod";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import type { RedactionContext } from "@ace/redaction";

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
const optionalText = z.string().optional().catch(undefined);
const optionalStatus = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{3}$/)
      .transform(Number),
  ])
  .optional()
  .catch(undefined);
const shape = z.object({
  code: z.union([z.string(), z.number()]).optional().catch(undefined),
  discoveryCode: DiscoveryFailureCode.optional().catch(undefined),
  name: optionalText,
  reason: optionalText,
  _tag: optionalText,
  detail: optionalText,
  message: optionalText,
  status: optionalStatus,
  statusCode: optionalStatus,
  cause: z.unknown().optional(),
  error: z.unknown().optional(),
  data: z.unknown().optional(),
  response: z.unknown().optional(),
  body: z.unknown().optional(),
});
/** Read only error fields; never stringify vendor objects, headers, stacks or credentials. */
function diagnostics(error: unknown) {
  const pending: unknown[] = [error];
  const entries: z.infer<typeof shape>[] = [];
  let parseFailure = false;
  for (let index = 0; index < pending.length && index < 12; index++) {
    const value = pending[index];
    if (value instanceof z.ZodError || value instanceof SyntaxError) parseFailure = true;
    const parsed = shape.safeParse(typeof value === "string" ? { message: value } : value);
    if (!parsed.success) continue;
    const detail = parsed.data;
    entries.push(detail);
    const message = detail.message ?? "";
    if (message.length <= 8192 && message.startsWith("{")) {
      try {
        pending.push(JSON.parse(message));
      } catch {
        /* Plain diagnostic prose. */
      }
    }
    for (const nested of [detail.cause, detail.error, detail.data, detail.response, detail.body])
      if (nested !== undefined) pending.push(nested);
  }
  return { entries, parseFailure };
}
/** Bounded inspection of provider diagnostics. Only a fixed category leaves this function. */
export function discoveryFailureCode(
  error: unknown,
  fallback: DiscoveryFailureCode = "discovery_failed",
): DiscoveryFailureCode {
  const { entries, parseFailure } = diagnostics(error);
  let text = "";
  for (const detail of entries) {
    // An outer generic wrapper must not hide a more specific nested failure.
    for (const value of [detail.discoveryCode, detail.code]) {
      const explicit = DiscoveryFailureCode.safeParse(value);
      if (explicit.success && explicit.data !== "discovery_failed") return explicit.data;
    }
    const status = detail.status ?? detail.statusCode;
    if (status === 401 || status === 403) return "auth_expired";
    if (status === 429) return "rate_limited";
    if (status !== undefined && status >= 500 && status <= 599) return "unreachable";
    text +=
      [
        detail.name,
        detail.reason,
        detail["_tag"],
        String(detail.code ?? ""),
        detail.detail,
        detail.message,
      ]
        .map((value) => value?.slice(0, 8192) ?? "")
        .join(" ") + " ";
  }
  if (parseFailure) return "parse_failure";
  return /not.configured|missing.api.key|no.api.key|not.logged.in|not.signed.in|(?:CURSOR_API_KEY|api.?key).*(?:required|missing|not.set)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|cannot.find.module|ENOENT/i.test(
    text,
  )
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

/** Unknown failures retain a bounded, redacted explanation instead of losing the reason again. */
export function discoveryFailureReason(error: unknown, context: RedactionContext = {}): string {
  const { entries } = diagnostics(error);
  let reason = "Provider supplied no error detail.";
  for (const entry of entries) {
    const text = entry.detail || entry.message;
    if (text && !text.startsWith("{")) reason = text;
  }
  if (reason.length > 65536) return "Provider error detail exceeded the safe diagnostic limit.";
  return createDiagnosticRedactor(context)(reason).replace(/\s+/g, " ").trim().slice(0, 2048);
}
