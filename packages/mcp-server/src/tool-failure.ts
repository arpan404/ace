import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";

const Detail = z.object({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  hint: z.string().optional(),
  message: z.string().optional(),
  blocked: z.object({ origin: z.string(), reason: z.string() }).optional(),
});
/** Errors cross a provider boundary: retain the reason, never a stack or input dump. */
function safeText(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/[a-f0-9]{64}/gi, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .slice(0, 2048);
}
function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
}
class ToolArgumentsError extends Error {
  readonly code = "invalid_arguments";
}
/** Distinguish malformed model arguments from malformed backend responses. */
export function parseToolArguments<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolArgumentsError(validationMessage(parsed.error));
  return parsed.data;
}
export function toolFailure(error: unknown): CallToolResult {
  const detail = Detail.safeParse(error);
  const known = detail.success ? detail.data : undefined;
  const validation = error instanceof z.ZodError;
  const message = validation
    ? `Invalid tool/backend data: ${validationMessage(error)}`
    : error instanceof Error && error.message.trim()
      ? error.message
      : known?.message?.trim()
        ? known.message
        : typeof error === "string" && error.trim()
          ? error
          : "Tool execution failed without an error message";
  const failure = {
    code: validation
      ? "invalid_data"
      : (known?.blocked?.reason ?? known?.code ?? "execution_failed"),
    message: safeText(message),
    ...(known?.hint ? { hint: safeText(known.hint) } : {}),
    ...(known?.blocked
      ? { blocked: { origin: safeText(known.blocked.origin), reason: known.blocked.reason } }
      : {}),
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
}
