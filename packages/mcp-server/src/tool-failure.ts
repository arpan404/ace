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
/** A path segment safe to show: a field name or index ace's schema owns, never a data key. */
const segment = (part: PropertyKey) =>
  typeof part === "number" || (typeof part === "string" && /^[A-Za-z_][\w-]{0,39}$/.test(part))
    ? String(part)
    : "*";
/**
 * Data a tool produced or read failed a schema, so the next failure says where; values never
 * leave. The agent sees the tool, and for its result the fields its published output schema
 * names; a schema read inside the tool shows the agent its issue codes only, and the log gets
 * the fields.
 */
export class ToolDataInvalid extends Error {
  readonly detail: string;
  constructor(tool: string, stage: "output" | "backend", error: z.ZodError) {
    const issues = error.issues.slice(0, 3);
    const fields = issues
      .map((issue) => `${issue.path.map(segment).join(".") || "(root)"} (${issue.code})`)
      .join(", ");
    super(
      stage === "output"
        ? `${tool}: its result breaks the output schema in ${fields}.`
        : `${tool}: data it read breaks a schema in ${fields}.`,
    );
    this.detail =
      stage === "output"
        ? this.message
        : `${tool}: data it read breaks a schema (${[...new Set(issues.map((issue) => issue.code))].join(", ")}).`;
  }
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
        error instanceof z.ZodError || error instanceof ToolDataInvalid
          ? "invalid_data"
          : "execution_failed",
        undefined,
        undefined,
        undefined,
        error instanceof ToolDataInvalid ? error.detail : undefined,
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
