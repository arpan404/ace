import type { ToolDetailDraft } from "@ace/core";
import { TodoEntry, type FileChange, type ToolStatus } from "@ace/protocol";
import { array, number, object, string, type Data } from "./data.ts";
export function detail(
  name: string,
  input: Data,
  metadata: Data,
  mcp: Set<string>,
): ToolDetailDraft {
  switch (name) {
    case "bash":
      return {
        kind: "shell",
        command: string(input.command),
        ...(typeof input.workdir === "string" ? { cwd: input.workdir } : {}),
        ...(metadata.exit === null || typeof metadata.exit === "number"
          ? { exitCode: metadata.exit }
          : {}),
      };
    case "read":
      return {
        kind: "file.read",
        path: string(input.filePath),
        ...(typeof input.offset === "number"
          ? {
              range: {
                start: number(input.offset),
                end: number(input.offset) + number(input.limit, 1),
              },
            }
          : {}),
      };
    case "edit":
    case "write":
      return {
        kind: name === "edit" ? "file.edit" : "file.write",
        changes: [
          {
            path: string(input.filePath),
            kind: name === "write" ? "add" : "update",
            ...(typeof metadata.diff === "string" ? { diff: metadata.diff } : {}),
            ...(typeof input.oldString === "string" ? { oldText: input.oldString } : {}),
            ...(typeof input.newString === "string"
              ? { newText: input.newString }
              : typeof input.content === "string"
                ? { newText: input.content }
                : {}),
          },
        ],
      };
    case "apply_patch": {
      const changes = array(metadata.files).map((entry): FileChange => {
        const f = object(entry);
        const type = string(f.type);
        const change: FileChange = {
          path: string(f.filePath, string(f.path)),
          kind: type === "add" || type === "delete" || type === "move" ? type : "update",
        };
        if (typeof f.diff === "string") change.diff = f.diff;
        if (typeof f.movePath === "string") change.movePath = f.movePath;
        return change;
      });
      const kinds = new Set(changes.map((c) => c.kind));
      return {
        kind:
          kinds.size === 1 && kinds.has("add")
            ? "file.write"
            : kinds.size === 1 && kinds.has("delete")
              ? "file.delete"
              : kinds.size === 1 && kinds.has("move")
                ? "file.move"
                : "file.edit",
        changes,
      };
    }
    case "glob":
    case "grep":
      return {
        kind: "search",
        query: string(input.pattern),
        ...(typeof input.path === "string" ? { path: input.path } : {}),
      };
    case "webfetch":
      return { kind: "web.fetch", url: string(input.url) };
    case "websearch":
      return { kind: "web.search", query: string(input.query) };
    case "task":
      return typeof input.task_id === "string"
        ? { kind: "agent.message", targetAgent: input.task_id, message: string(input.prompt) }
        : {
            kind: "agent.spawn",
            description: string(input.description),
            prompt: string(input.prompt),
            agentType: string(input.subagent_type),
            ...(typeof metadata.sessionId === "string" ? { childAgent: metadata.sessionId } : {}),
          };
    case "todowrite":
      return {
        kind: "todo",
        todos: array(input.todos).flatMap((v) => {
          const parsed = TodoEntry.safeParse(v);
          return parsed.success ? [parsed.data] : [];
        }),
      };
    case "question":
      return { kind: "ask_user" };
    case "plan_enter":
    case "plan_exit":
      return { kind: "plan" };
    default: {
      const server = [...mcp]
        .filter((s) => name.startsWith(`${s}_`))
        .toSorted((a, b) => b.length - a.length)[0];
      return server
        ? { kind: "mcp", server, tool: name.slice(server.length + 1), arguments: input }
        : { kind: "custom" };
    }
  }
}
export function toolStatus(state: Data, aborted: boolean): ToolStatus {
  if (state.status === "pending") return "pending";
  if (state.status === "running") return "running";
  if (
    aborted ||
    (object(state.metadata).exit === null && /User aborted the command/.test(string(state.output)))
  )
    return "cancelled";
  if (state.status === "completed") return "succeeded";
  if (/dismissed|rejected|denied/i.test(string(state.error))) return "declined";
  return state.status === "error" ? "failed" : "pending";
}
