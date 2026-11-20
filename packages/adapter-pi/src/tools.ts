import type { ToolDetailDraft } from "@ace/core";
import type { FileChange } from "@ace/protocol";
import { bareToolName } from "@ace/provider-kit/ace-tool-names";
import { obj, str, list } from "./native.ts";
export function toolDetail(name: string, args: unknown): ToolDetailDraft {
  const a = obj(args);
  if (name === "bash") return { kind: "shell", command: str(a.command) };
  if (name === "read") return { kind: "file.read", path: str(a.path) };
  if (name === "write")
    return {
      kind: "file.write",
      changes: [
        {
          path: str(a.path),
          kind: "add",
          ...(typeof a.content === "string" ? { newText: a.content } : {}),
        },
      ],
    };
  if (name === "edit") return { kind: "file.edit", changes: replacements(a) };
  if (["grep", "find", "ls"].includes(name))
    return { kind: "search", query: str(a.pattern), path: str(a.path) };
  // ace's extension tools are `ace_<bare name>` (piToolName); the MCP detail carries the bare name.
  if (name.startsWith("ace_"))
    return { kind: "mcp", server: "ace", tool: bareToolName(name), arguments: args };
  return { kind: "custom" };
}
/**
 * The text each replacement of a Pi edit swapped: `edits[]`, plus the single top-level
 * `oldText`/`newText` older Pi sends. Enough for a diff until the result brings Pi's patch.
 */
function replacements(a: Record<string, unknown>): FileChange[] {
  const path = str(a.path);
  const pairs = [...list(a.edits).map(obj), a];
  const changes = pairs.flatMap((pair): FileChange[] =>
    typeof pair.oldText === "string" && typeof pair.newText === "string"
      ? [{ path, kind: "update", oldText: pair.oldText, newText: pair.newText }]
      : [],
  );
  return changes.length ? changes : [{ path, kind: "update" }];
}
/** A patch larger than this is left out rather than kept in the item. */
const maxPatch = 1 << 20;
/**
 * A finished Pi edit's change with the unified patch Pi wrote (`details.patch`, Pi 1.5+). The
 * patch numbers its hunks against the whole file, where the replaced fragments cannot.
 * Undefined when the result has no usable patch, so the replacements' text stays.
 */
export function editResultDetail(
  name: string,
  args: unknown,
  result: unknown,
): ToolDetailDraft | undefined {
  if (name !== "edit") return undefined;
  const patch = obj(obj(result).details).patch;
  const path = str(obj(args).path);
  if (typeof patch !== "string" || !patch || patch.length > maxPatch || !path) return undefined;
  return { kind: "file.edit", changes: [{ path, kind: "update", diff: patch }] };
}
export function resultText(value: unknown): string {
  return list(obj(value).content)
    .map((block) => str(obj(block).text))
    .join("\n");
}
/** Visit cumulative blocks without joining or copying their historical prefix. */
export function resultSuffix(value: unknown, seen: number): { append: string; length: number } {
  const parts: string[] = [];
  let length = 0,
    first = true;
  for (const block of list(obj(value).content)) {
    if (!first) {
      if (length >= seen) parts.push("\n");
      length++;
    }
    first = false;
    const text = str(obj(block).text),
      end = length + text.length;
    if (end > seen) parts.push(text.slice(Math.max(0, seen - length)));
    length = end;
  }
  return { append: parts.join(""), length };
}
