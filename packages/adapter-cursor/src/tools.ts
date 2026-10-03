import type { ToolDetailDraft } from "@ace/core";
import type { ToolKind, ToolStatus } from "@ace/protocol";
import { TodoEntry } from "@ace/protocol";
import { z } from "zod";
import { object, string } from "./contracts.ts";

const kinds: Record<string, ToolKind> = {
  shell: "shell",
  read: "file.read",
  edit: "file.edit",
  write: "file.write",
  delete: "file.delete",
  grep: "search",
  glob: "search",
  ls: "search",
  sem_search: "search",
  semsearch: "search",
  mcp: "mcp",
  task: "agent.spawn",
  generateimage: "image",
  recordscreen: "browser",
  update_todos: "todo",
  updatetodos: "todo",
  create_plan: "plan",
  createplan: "plan",
  ask_question: "ask_user",
};
export function toolKind(name: string): ToolKind {
  return kinds[name.toLowerCase()] ?? "custom";
}
export function toolStatus(status: unknown, result: unknown): ToolStatus {
  const data = object(result);
  const value = object(data.value);
  if (
    status === "error" ||
    data.status === "error" ||
    data.status === "rejected" ||
    data.status === "denied" ||
    value.permissionDenied === true ||
    value.rejected === true ||
    value.isError === true ||
    (typeof value.exitCode === "number" && value.exitCode !== 0)
  )
    return "failed";
  return status === "completed" ? "succeeded" : "running";
}
export function toolDetail(name: string, args: unknown, result: unknown): ToolDetailDraft {
  const kind = toolKind(name);
  const input = object(args);
  const value = object(object(result).value);
  const path = string(input.path) ?? string(input.filePath) ?? "";
  switch (kind) {
    case "shell":
      return {
        kind,
        command: string(input.command) ?? "",
        ...(string(input.workingDirectory) ? { cwd: string(input.workingDirectory) } : {}),
        ...(typeof value.exitCode === "number" && Number.isInteger(value.exitCode)
          ? { exitCode: value.exitCode }
          : {}),
      };
    case "file.read":
      return { kind, path };
    case "file.edit":
    case "file.write":
    case "file.delete":
      return {
        kind,
        changes: [
          {
            path,
            kind: kind === "file.write" ? "add" : kind === "file.delete" ? "delete" : "update",
            ...(string(input.oldString) === undefined ? {} : { oldText: string(input.oldString) }),
            ...((string(input.fileText) ?? string(input.newString)) === undefined
              ? {}
              : { newText: string(input.fileText) ?? string(input.newString) }),
            ...((string(value.diffString) ?? string(value.diff)) === undefined
              ? {}
              : { diff: string(value.diffString) ?? string(value.diff) }),
          },
        ],
      };
    case "search":
      return { kind, query: string(input.pattern) ?? string(input.query) ?? path };
    case "mcp":
      return {
        kind,
        server: string(input.providerIdentifier) ?? string(input.server) ?? "unknown",
        tool: string(input.tool) ?? string(input.toolName) ?? name,
        ...((input.args ?? input.arguments) === undefined
          ? {}
          : { arguments: input.args ?? input.arguments }),
      };
    case "agent.spawn":
      return {
        kind,
        ...(string(input.description) ? { description: string(input.description) } : {}),
        ...(string(input.prompt) ? { prompt: string(input.prompt) } : {}),
      };
    case "todo": {
      const native = z
        .array(z.object({ content: z.string(), status: z.string(), id: z.string().optional() }))
        .max(128)
        .safeParse(input.todos ?? value.todos);
      const todos = z
        .array(TodoEntry)
        .max(128)
        .safeParse(
          native.success
            ? native.data.map((todo) => ({
                content: todo.content,
                id: todo.id,
                status: todo.status === "inProgress" ? "in_progress" : todo.status,
              }))
            : [],
        );
      return { kind, todos: todos.success ? todos.data : [] };
    }
    case "plan":
      return {
        kind,
        ...((string(input.plan) ?? string(input.markdown))
          ? { markdown: string(input.plan) ?? string(input.markdown) }
          : {}),
      };
    case "ask_user":
      return { kind };
    case "image":
    case "browser":
      return { kind };
    default:
      return { kind: "custom" };
  }
}
