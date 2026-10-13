import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Principal } from "./credentials.ts";
import type { SessionAwareness } from "./awareness.ts";

const FailureCode = z.object({ code: z.string().max(64) });
const ControlFailure = z.object({ ok: z.literal(false), code: z.string().max(64) });

/**
 * Remember the failure for the brief, then append what changed since this session's last ace
 * call. The digest is a separate text block (and `_meta`), so `structuredContent` still
 * matches the tool's output schema.
 */
export function withChanges(
  awareness: SessionAwareness,
  principal: Principal,
  tool: string,
  result: CallToolResult,
): CallToolResult {
  const code = failureCode(result);
  if (code) awareness.failed(principal, tool, code);
  const changes = awareness.changes(principal);
  if (!changes) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: changes }],
    _meta: { ...result["_meta"], "ace/changes": changes },
  };
}

function failureCode(result: CallToolResult): string | undefined {
  const control = ControlFailure.safeParse(result.structuredContent);
  if (control.success) return control.data.code;
  if (!result.isError) return undefined;
  const first = result.content[0];
  if (first?.type !== "text") return "failed";
  try {
    return FailureCode.safeParse(JSON.parse(first.text)).data?.code ?? "failed";
  } catch {
    return "failed";
  }
}
