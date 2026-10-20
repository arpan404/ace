import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { PublicToolError } from "./public-error.ts";
import { argumentIssues, shapeIssue } from "./argument-issues.ts";

/**
 * Intentionally public failures carry fixed messages. Code-shaped backend objects are untrusted.
 * A call shaped wrong (a field or variant that does not exist) also learns where the schema is.
 */
export function parseToolArguments<T extends z.ZodType>(
  schema: T,
  value: unknown,
  tool?: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new PublicToolError(
      "invalid_arguments",
      undefined,
      undefined,
      undefined,
      tool && shapeIssue(parsed.error) ? `tools_find ${tool} returns its schema.` : undefined,
      argumentIssues(parsed.error, schema),
    );
  return parsed.data;
}
/** Arguments too large to read: the agent can send less, so the reason is public. */
export function inputTooLarge(maxBytes: number): PublicToolError {
  return new PublicToolError(
    "limit",
    undefined,
    undefined,
    undefined,
    `The arguments exceed ${Math.floor(maxBytes / 1024)} KiB as JSON. Send less in one call.`,
  );
}
const Origin = z.object({
  blocked: z.object({
    origin: z.string().max(8192),
    reason: z.enum(["approval_required", "timeout", "invalid_origin"]),
  }),
});
function publicOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return "invalid origin";
    return url.origin.replace(/[a-f0-9]{64}/gi, "[redacted]");
  } catch {
    return "invalid origin";
  }
}
/**
 * The agent-facing result for a failure. A non-public error becomes a fixed code; `errorId`
 * names the log entry its private cause went to, so a person can find it.
 */
export function toolFailure(error: unknown, errorId?: string): CallToolResult {
  const trusted = error instanceof PublicToolError;
  const failure = trusted
    ? new PublicToolError(
        error.code,
        error.permission,
        error.phase,
        error.candidates,
        error.detail,
        error.issues,
        error.errorId,
      )
    : new PublicToolError(
        error instanceof z.ZodError ? "invalid_data" : "execution_failed",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        errorId,
      );
  const origin = trusted ? Origin.safeParse(error) : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: failure.code,
          message: failure.message,
          hint: failure.hint,
          ...(failure.issues ? { issues: failure.issues } : {}),
          ...(failure.detail ? { detail: failure.detail } : {}),
          ...(failure.phase ? { phase: failure.phase } : {}),
          ...(failure.candidates ? { candidates: failure.candidates } : {}),
          ...(failure.permission ? { permission: failure.permission } : {}),
          ...(failure.errorId ? { errorId: failure.errorId } : {}),
          ...(origin?.success
            ? {
                blocked: {
                  origin: publicOrigin(origin.data.blocked.origin),
                  reason: origin.data.blocked.reason,
                },
              }
            : {}),
        }),
      },
    ],
  };
}
