import type { ToolDetailDraft } from "@ace/core";
import { TodoEntry, type ToolStatus } from "@ace/protocol";
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
  const mcp = object(object(update["_meta"])["mcp"]);
  let kind =
    quirks.toolKind(update) ??
    (typeof mcp["server"] === "string" && typeof mcp["tool"] === "string" ? "mcp" : undefined) ??
    (Object.hasOwn(mapping, string(update["kind"]))
      ? (mapping[string(update["kind"])] ?? "custom")
      : "custom");
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
        command: firstString(input, ["command", "CommandLine", "commandLine", "command_line"]),
        ...(firstString(input, cwdFields) ? { cwd: firstString(input, cwdFields) } : {}),
        ...(typeof output["exitCode"] === "number" && Number.isInteger(output["exitCode"])
          ? { exitCode: output["exitCode"] }
          : {}),
      };
    case "file.read":
      return {
        kind,
        path:
          firstString(input, ["path", "TargetFile", "file_path"]) ||
          string(object(list(update["locations"])[0])["path"]),
      };
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
      // The call's MCP metadata names it; only a recognized envelope's fields stand in for it.
      const envelope = mcpEnvelope(input);
      return {
        kind,
        server: string(mcp["server"]) || string(envelope?.["providerIdentifier"]),
        tool: string(mcp["tool"]) || string(envelope?.["toolName"]),
        arguments: mcpArguments(input),
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
      return { kind, todos: todos(input["todos"]) };
    default:
      return { kind };
  }
}

const cwdFields = ["Cwd", "cwd", "working_dir", "workingDir"];
function firstString(input: Data, keys: readonly string[]): string {
  for (const key of keys) if (typeof input[key] === "string") return input[key];
  return "";
}

const envelopeFields = new Set(["providerIdentifier", "toolName", "args", "arguments"]);
/**
 * The envelope some agents wrap an MCP call in (`{providerIdentifier, toolName, arguments}`, or
 * a lone `args`/`arguments`), else undefined: a call whose own parameters merely include one of
 * these names is not an envelope.
 */
function mcpEnvelope(input: Data): Data | undefined {
  const keys = Object.keys(input).filter((key) => key !== "_toolName");
  if (!keys.length || !keys.every((key) => envelopeFields.has(key))) return undefined;
  const wrapped = keys.includes("args") || keys.includes("arguments");
  const named =
    typeof input["providerIdentifier"] === "string" || typeof input["toolName"] === "string";
  return wrapped || named ? input : undefined;
}

/** MCP call arguments: unwrapped from a recognized envelope, else the input as sent. */
export function mcpArguments(input: Data): unknown {
  const envelope = mcpEnvelope(input);
  if (!envelope) return input;
  if (Object.hasOwn(envelope, "args")) return envelope["args"];
  const wrapped = envelope["arguments"];
  if (wrapped !== null && typeof wrapped === "object" && !Array.isArray(wrapped)) return wrapped;
  return Object.hasOwn(envelope, "arguments") ? input : {};
}

/** The failure text a terminal update carries: a bare string result or its `error` field. */
export function toolError(update: Data): string | undefined {
  const output = update["rawOutput"];
  const error = typeof output === "string" ? output : object(output)["error"];
  const text = typeof error === "string" ? error : string(object(error)["message"]);
  return text.trim() ? text.slice(0, errorLimit) : undefined;
}
const errorLimit = 16 * 1024;

/** Agents title some calls with a running label ("Running view_file") that outlives the call. */
export function toolTitle(data: Data, detail: ToolDetailDraft): string {
  const title = string(data["title"]);
  if (detail.kind === "file.read" && detail.path && (!title || /^Running [\w.-]+$/.test(title)))
    return `Read ${displaySafe(detail.path)}`;
  return title;
}
/**
 * Text ace writes into a generated title, with line breaks, other controls and bidirectional
 * overrides shown as escapes, so a crafted path cannot fake or hide part of the title. The
 * original stays in the tool's detail.
 */
function displaySafe(text: string): string {
  return text.replace(
    // oxlint-disable-next-line no-control-regex -- matching controls is the point
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

export function todos(value: unknown): TodoEntry[] {
  return list(value).flatMap((entry) => {
    const parsed = TodoEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Carry interpreted fields between partial refreshes; opaque history belongs to the raw collector. */
export function mergeToolData(data: Data, update: Data): void {
  for (const field of [
    "kind",
    "title",
    "name",
    "rawInput",
    "rawOutput",
    "content",
    "_meta",
    "locations",
  ]) {
    if (!Object.hasOwn(update, field)) continue;
    const value = update[field];
    if (["name", "title", "kind"].includes(field) && typeof value !== "string") continue;
    if (field === "rawInput") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const previous = object(data[field]);
      const retained: Data = {};
      for (const key of inputFields)
        if (Object.hasOwn(previous, key)) retained[key] = previous[key];
      // Interpret known fields plus this change, not accumulated opaque input history.
      data[field] = { ...retained, ...object(value) };
    } else if (field === "rawOutput") {
      const output = object(value);
      data[field] = {
        ...object(data[field]),
        ...Object.fromEntries(
          outputFields.filter((key) => Object.hasOwn(output, key)).map((key) => [key, output[key]]),
        ),
      };
    } else data[field] = value;
  }
}
// Failure payloads only determine the compact tool status in toolStatus. Their full
// evidence belongs to canonical raw data or diagnostics, never retained tool data.
const outputFields = ["exitCode", "totalFiles", "isBackground"];
const inputFields = [
  "_toolName",
  "command",
  "CommandLine",
  "commandLine",
  "command_line",
  "Cwd",
  "cwd",
  "working_dir",
  "workingDir",
  "path",
  "TargetFile",
  "file_path",
  "pattern",
  "query",
  "SearchDirectory",
  "Query",
  "url",
  "Url",
  "providerIdentifier",
  "toolName",
  "args",
  "arguments",
  "description",
  "prompt",
  "subagentType",
  "plan",
  "todos",
];
