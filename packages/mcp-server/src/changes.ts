import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Principal } from "./credentials.ts";
import type { SessionAwareness } from "./awareness.ts";

const FailureCode = z.object({ code: z.string().max(64) });
const ControlFailure = z.object({ ok: z.literal(false), code: z.string().max(64) });

/**
 * Which part of a tool result reaches the client's model. Claude Code, OpenCode and Pi show
 * the model the text blocks; Codex shows it `structuredContent` and drops the text when both
 * are present (its code mode hands the script both).
 */
export type ResultReader = "text" | "structured";
/** The header a client sends to say it reads `structuredContent` (Codex). */
export const structuredClientHeader = { name: "X-Ace-Client", value: "codex" } as const;
/** The reader a client's headers name; anything else reads text. */
export function resultReader(header: string | null | undefined): ResultReader {
  return header === structuredClientHeader.value ? "structured" : "text";
}
/** Reserved `structuredContent` key for the digest; no tool's own output uses it. */
export const changesKey = "aceChanges";

/**
 * Remember the failure for the brief, then add what changed since this session's last ace
 * call where the client's model reads it: a text block for text readers, and a reserved key in
 * `structuredContent` (advertised output schemas stay open to extra keys) so a client that
 * reads only structured results sees it too. A structured reader gets no text copy, which its
 * code mode would otherwise print twice; a result without `structuredContent` (a failure, an
 * image) carries the text block for every client.
 */
export function withChanges(
  awareness: SessionAwareness,
  principal: Principal,
  tool: string,
  result: CallToolResult,
  reader: ResultReader = "text",
): CallToolResult {
  const code = failureCode(result);
  if (code) awareness.failed(principal, tool, code);
  const changes = awareness.changes(principal);
  if (!changes) return result;
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  return {
    ...result,
    content:
      structured && reader === "structured"
        ? result.content
        : [...result.content, { type: "text", text: changes }],
    ...(structured ? { structuredContent: { ...structured, [changesKey]: changes } } : {}),
    _meta: { ...result["_meta"], "ace/changes": changes },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
