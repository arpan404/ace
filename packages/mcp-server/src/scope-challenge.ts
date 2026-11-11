/*
 * The HTTP answer to a tool call the caller's token doesn't cover (RFC 6750 §3.1, MCP
 * authorization "insufficient scope"): 403 with `WWW-Authenticate: Bearer
 * error="insufficient_scope", scope="…"`, so a client can ask the person for more access. The
 * host decides what each principal lacks; this module only reads the call and answers.
 */
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Principal } from "./credentials.ts";
import { dispatchedAceCall } from "./tool-names.ts";

export interface ScopeChallenge {
  /**
   * The scope `principal` lacks to call `tool` with `args` (a `tools_call` reads as the call it
   * runs), or undefined when it may.
   */
  missingScope(principal: Principal, tool: string, args: unknown): string | undefined;
  /** Extra `WWW-Authenticate` parameters, such as `resource_metadata` (RFC 9728). */
  parameters?(): Readonly<Record<string, string>>;
}

export type ScopeCheck =
  | { kind: "forward"; body: Buffer }
  | { kind: "refuse"; status: 403 | 413; headers: Record<string, string>; body: string };

const ToolCall = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.literal("tools/call"),
  params: z.object({ name: z.string().max(256), arguments: z.unknown().optional() }),
});
/** Header parameter values are quoted strings; a host's value never breaks out of one. */
const quotable = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

/** Reads the request body (bounded) and refuses a tool call outside the principal's scope. */
export async function scopeRefusal(
  request: IncomingMessage,
  principal: Principal,
  challenge: ScopeChallenge,
  maxBytes: number,
): Promise<ScopeCheck> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > maxBytes) return { kind: "refuse", status: 413, headers: {}, body: "" };
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  let message: unknown;
  try {
    message = JSON.parse(body.toString("utf8"));
  } catch {
    // Not JSON: the MCP handler answers it with its own parse error.
    return { kind: "forward", body };
  }
  const call = ToolCall.safeParse(message);
  if (!call.success) return { kind: "forward", body };
  const target = dispatchedAceCall(call.data.params.name, call.data.params.arguments ?? {});
  const scope = challenge.missingScope(principal, target.name, target.input);
  if (scope === undefined) return { kind: "forward", body };
  const parameters = {
    error: "insufficient_scope",
    scope,
    error_description: `This tool needs the ${scope} scope.`,
    ...challenge.parameters?.(),
  };
  const header = Object.entries(parameters)
    .filter(([, value]) => quotable.test(value))
    .map(([key, value]) => `${key}="${value}"`)
    .join(", ");
  return {
    kind: "refuse",
    status: 403,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer ${header}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: call.data.id ?? null,
      error: { code: -32003, message: `Forbidden: needs the ${scope} scope`, data: { scope } },
    }),
  };
}
