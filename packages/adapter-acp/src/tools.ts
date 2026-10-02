import type { ToolDetailDraft } from "@ace/core";
import type { ToolStatus } from "@ace/protocol";
import { list, object, string, type Data } from "./data.ts";
import type { AcpQuirks } from "./quirks/types.ts";
export function toolStatus(update: Data, previous: ToolStatus): ToolStatus {
  const output = object(update["rawOutput"]);
  if (update["status"] === "completed") {
    if (output["rejected"]) return "declined";
    if (
      output["error"] ||
      output["permissionDenied"] ||
      (typeof output["exitCode"] === "number" && output["exitCode"] !== 0)
    )
      return "failed";
    return "succeeded";
  }
  switch (update["status"]) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return previous;
  }
}
export function toolDetail(update: Data, quirks: AcpQuirks): ToolDetailDraft {
  const input = object(update["rawInput"]);
  const output = object(update["rawOutput"]);
  const mapping: Record<string, ToolDetailDraft["kind"]> = {
    execute: "shell",
    read: "file.read",
    edit: "file.edit",
    delete: "file.delete",
    move: "file.move",
    search: "search",
    fetch: "web.fetch",
  };
  let kind =
    quirks.toolKind(update) ??
    (Object.hasOwn(mapping, string(update["kind"])) ? mapping[string(update["kind"])]! : "custom");
  const changes = list(update["content"])
    .map(object)
    .filter((c) => c["type"] === "diff")
    .map((c) => ({
      path: string(c["path"]),
      kind: c["oldText"] == null ? ("add" as const) : ("update" as const),
      oldText: typeof c["oldText"] === "string" ? c["oldText"] : null,
      newText: string(c["newText"]),
    }));
  if (kind === "file.edit" && changes.length && changes.every((c) => c.kind === "add"))
    kind = "file.write";
  switch (kind) {
    case "shell":
      return {
        kind,
        command: string(input["command"] ?? input["CommandLine"] ?? input["commandLine"]),
        ...(typeof input["Cwd"] === "string" ? { cwd: input["Cwd"] } : {}),
        ...(typeof output["exitCode"] === "number" && Number.isInteger(output["exitCode"])
          ? { exitCode: output["exitCode"] }
          : {}),
        ...(output["stdout"] !== undefined || output["combinedOutput"] !== undefined
          ? {
              output:
                string(output["combinedOutput"]) ||
                string(output["stdout"]) + string(output["stderr"]),
            }
          : {}),
      };
    case "file.read":
      return { kind, path: string(input["path"] ?? input["TargetFile"] ?? input["file_path"]) };
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
      return { kind, changes };
    case "search":
      return {
        kind,
        query: string(input["pattern"] ?? input["query"] ?? input["SearchDirectory"]),
        ...(typeof output["totalFiles"] === "number" && Number.isInteger(output["totalFiles"])
          ? { matches: output["totalFiles"] }
          : {}),
      };
    case "web.search":
      return { kind, query: string(input["query"] ?? input["Query"]) };
    case "web.fetch":
      return { kind, url: string(input["url"] ?? input["Url"]) };
    case "mcp": {
      const meta = object(object(update["_meta"])["mcp"]);
      return {
        kind,
        server: string(input["providerIdentifier"] ?? meta["server"]),
        tool: string(input["toolName"] ?? meta["tool"]),
        arguments: input["args"] ?? input,
      };
    }
    case "agent.spawn":
      return {
        kind,
        description: string(input["description"]),
        prompt: string(input["prompt"]),
        agentType: Object.keys(object(input["subagentType"]))[0] ?? "",
      };
    case "plan":
      return { kind, markdown: string(input["plan"]) };
    case "todo":
      return { kind, todos: [] };
    default:
      return { kind };
  }
}
