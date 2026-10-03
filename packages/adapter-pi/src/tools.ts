import type { ToolDetailDraft } from "@ace/core";
import { obj, str, list } from "./native.ts";
export function toolDetail(name: string, args: unknown): ToolDetailDraft {
  const a = obj(args);
  if (name === "bash") return { kind: "shell", command: str(a.command) };
  if (name === "read") return { kind: "file.read", path: str(a.path) };
  if (name === "write" || name === "edit")
    return {
      kind: name === "write" ? "file.write" : "file.edit",
      changes: [
        {
          path: str(a.path),
          kind: name === "write" ? "add" : "update",
          ...(typeof a.content === "string" ? { newText: a.content } : {}),
        },
      ],
    };
  if (["grep", "find", "ls"].includes(name))
    return { kind: "search", query: str(a.pattern), path: str(a.path) };
  if (name.startsWith("ace_")) return { kind: "mcp", server: "ace", tool: name, arguments: args };
  return { kind: "custom" };
}
export function resultText(value: unknown): string {
  return list(obj(value).content)
    .map((block) => str(obj(block).text))
    .join("\n");
}
