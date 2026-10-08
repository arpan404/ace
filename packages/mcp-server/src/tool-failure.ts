import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { PublicToolError } from "./public-error.ts";

/** Intentionally public failures carry fixed messages. Code-shaped backend objects are untrusted. */
export function parseToolArguments<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PublicToolError("invalid_arguments");
  return parsed.data;
}
const Origin = z.object({
  blocked: z.object({
    origin: z.string().max(8192),
    reason: z.enum(["approval_required", "denied", "read_only", "timeout", "invalid_origin"]),
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
export function toolFailure(error: unknown): CallToolResult {
  const trusted = error instanceof PublicToolError;
  const failure = trusted
    ? new PublicToolError(error.code, error.permission)
    : new PublicToolError(error instanceof z.ZodError ? "invalid_data" : "execution_failed");
  const dispatch = trusted
    ? z
        .object({
          phase: z.enum(["rejected-before-dispatch", "dispatched", "partial"]).optional(),
          candidates: z
            .array(
              z.object({
                windowId: z.number().int().positive(),
                bundleId: z.string().max(256).optional(),
                title: z.string().max(1024),
                bounds: z
                  .object({
                    x: z.number().finite(),
                    y: z.number().finite(),
                    w: z.number().finite(),
                    h: z.number().finite(),
                  })
                  .optional(),
              }),
            )
            .max(2048)
            .optional(),
        })
        .safeParse(error)
    : undefined;
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
          ...(dispatch?.success ? dispatch.data : {}),
          ...(failure.permission ? { permission: failure.permission } : {}),
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
