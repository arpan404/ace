import type { ToolDetailDraft } from "@ace/core";
import type { ToolKind } from "@ace/protocol";
import { object, string } from "./native.ts";
const kinds: Record<string, ToolKind> = {
  Bash: "shell",
  PowerShell: "shell",
  Monitor: "shell",
  Read: "file.read",
  Edit: "file.edit",
  Write: "file.write",
  NotebookEdit: "notebook",
  Glob: "search",
  Grep: "search",
  LSP: "search",
  ToolSearch: "search",
  WebSearch: "web.search",
  WebFetch: "web.fetch",
  Agent: "agent.spawn",
  Task: "agent.spawn",
  Workflow: "agent.spawn",
  SendMessage: "agent.message",
  ListAgents: "agent.message",
  SubagentHandback: "agent.message",
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
  TaskGet: "todo",
  TaskList: "todo",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan",
  AskUserQuestion: "ask_user",
  ListMcpResourcesTool: "mcp",
  ReadMcpResourceTool: "mcp",
  ReadMcpResourceDirTool: "mcp",
  RefreshMcpTools: "mcp",
  WaitForMcpServers: "mcp",
};
export function toolDetail(name: string, value: unknown): ToolDetailDraft {
  const input = object(value);
  const kind = name.startsWith("mcp__")
    ? "mcp"
    : Object.hasOwn(kinds, name)
      ? (kinds[name] ?? "custom")
      : "custom";
  switch (kind) {
    case "shell":
      return { kind, command: string(input["command"]) };
    case "file.read":
      return { kind, path: string(input["file_path"]) };
    case "file.edit":
    case "file.write":
      return {
        kind,
        changes: [
          {
            path: string(input["file_path"]),
            kind: kind === "file.write" ? "add" : "update",
            ...(typeof input["old_string"] === "string" ? { oldText: input["old_string"] } : {}),
            ...(typeof input["new_string"] === "string" ? { newText: input["new_string"] } : {}),
            ...(typeof input["content"] === "string" ? { newText: input["content"] } : {}),
          },
        ],
      };
    case "search":
    case "web.search":
      return { kind, query: string(input["query"], string(input["pattern"])) };
    case "web.fetch":
      return { kind, url: string(input["url"]) };
    case "mcp":
      return {
        kind,
        server: name.split("__")[1] ?? "claude",
        tool: name.split("__").slice(2).join("__") || name,
        arguments: value,
      };
    case "agent.spawn":
      return { kind, description: string(input["description"]), prompt: string(input["prompt"]) };
    case "agent.message":
      return { kind, message: string(input["message"]) };
    case "todo":
      return { kind, todos: [] };
    case "plan":
      return { kind, markdown: string(input["plan"]) };
    default:
      return { kind };
  }
}
