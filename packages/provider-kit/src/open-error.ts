import { z } from "zod";
import { createTextRedactor, type RedactionContext } from "@ace/redaction";

const Fields = z.object({
  code: z.string().optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  _tag: z.string().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  detail: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

/** Only sanitized fields survive the provider boundary; no raw cause or stack is retained. */
export class SessionOpenError extends Error {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  constructor(
    title: string,
    error: unknown,
    context: RedactionContext = {},
    redact: (value: unknown) => unknown = (value) => value,
  ) {
    const scrub = createTextRedactor(context);
    const fields = Fields.safeParse(error);
    const source = fields.success ? fields.data : {};
    const safe = (value: string, limit: number) => {
      const redacted = redact(value);
      return scrub(typeof redacted === "string" ? redacted : "Error detail unavailable").slice(
        0,
        limit,
      );
    };
    const code = safe(source.code || source.reason || source["_tag"] || "session_open_failed", 256);
    const safeTitle = safe(source.title || title, 256);
    const detail = safe(
      source.detail ||
        source.message ||
        (typeof error === "string" ? error : "Unknown provider error"),
      2048,
    );
    super(`${safeTitle}: ${detail}`);
    this.name = "SessionOpenError";
    this.code = code || "session_open_failed";
    this.title = safeTitle;
    this.detail = detail;
  }
}
