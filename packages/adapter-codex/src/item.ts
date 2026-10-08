import { commandDetail } from "./command-items.ts";
import type { ItemDraft, ToolDetailDraft } from "@ace/core";
import type { ContentPart, FileChange, ToolStatus } from "@ace/protocol";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";
import { list, obj, raw, str, type Obj } from "./native.ts";

const messages = {
  user: "userMessage",
  assistant: "agentMessage",
  reasoning: "reasoning",
} satisfies Record<string, ThreadItem["type"]>;
function fileChange(entry: unknown): FileChange {
  const c = obj(entry);
  const k = obj(c["kind"]);
  const movePath = str(k["move_path"]);
  const kind = movePath
    ? "move"
    : k["type"] === "add"
      ? "add"
      : k["type"] === "delete"
        ? "delete"
        : "update";
  return {
    path: str(c["path"]),
    kind,
    ...(movePath ? { movePath } : {}),
    ...(typeof c["diff"] === "string" ? { diff: c["diff"] } : {}),
  };
}
export function content(value: unknown): ContentPart[] {
  return list(value).flatMap((entry): ContentPart[] => {
    const p = obj(entry);
    if (p["type"] === "text") return [{ type: "text", text: str(p["text"]) }];
    if (p["type"] === "image") return [{ type: "image", mimeType: "image/*", url: str(p["url"]) }];
    if (p["type"] === "localImage" || p["type"] === "mention" || p["type"] === "skill")
      return [{ type: "file", path: str(p["path"]) }];
    return [];
  });
}
export function toolDraft(
  detail: ToolDetailDraft,
  title: string,
  data: unknown,
  status: ToolStatus,
  type: string,
  name?: unknown,
): ItemDraft {
  return {
    type: "tool_call",
    complete: !["running", "pending", "awaiting_approval"].includes(status),
    call: {
      kind: detail.kind,
      title,
      detail,
      status,
      raw: raw(type, data, name),
      ...(type === "mcpToolCall" && typeof obj(obj(data).error).message === "string"
        ? { error: str(obj(obj(data).error).message).slice(0, 4096) }
        : {}),
    },
  };
}
export function itemDraft(item: Obj, complete: boolean): ItemDraft {
  const type = str(item["type"]);
  // The generated union documents known variants; decoding remains open to new ones.
  switch (type) {
    case messages.user:
      return {
        type: "message",
        role: "user",
        ...(str(item["clientId"]) && str(item["clientId"]).length <= 256
          ? { nativeId: str(item["clientId"]) }
          : {}),
        parts: content(item["content"]),
        complete,
        raw: raw(type, item),
      };
    case messages.assistant:
      if (item["delivery"] === "async" && list(item["questions"]).length)
        return toolDraft(
          { kind: "ask_user" },
          str(item["text"], "Question"),
          item,
          complete ? "succeeded" : "running",
          type,
        );
      return {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: str(item["text"]) }],
        complete,
        raw: raw(type, item),
      };
    case messages.reasoning:
      return {
        type: "reasoning",
        text: [...list(item["summary"]), ...list(item["content"])]
          .filter((v): v is string => typeof v === "string")
          .join("\n"),
        summary: true,
        complete,
        raw: raw(type, item),
      };
    default:
      break;
  }
  const nativeStatus = str(item["status"]);
  const status: ToolStatus = !complete
    ? "running"
    : nativeStatus === "failed" || item["success"] === false
      ? "failed"
      : nativeStatus === "declined"
        ? "declined"
        : "succeeded";
  let detail: ToolDetailDraft = { kind: "custom" };
  let title = type;
  let name: unknown = item["name"];
  if (type === "commandExecution") {
    detail = commandDetail(item);
    const command =
      detail.kind === "shell"
        ? detail.command
        : str(obj(list(item["commandActions"])[0])["command"], str(item["command"]));
    title = `Run ${command}`;
  } else if (type === "fileChange") {
    const changes = list(item["changes"]).map(fileChange);
    const kind = changes[0]?.kind;
    detail = {
      kind:
        kind === "add"
          ? "file.write"
          : kind === "delete"
            ? "file.delete"
            : kind === "move"
              ? "file.move"
              : "file.edit",
      changes,
    };
  } else if (type === "mcpToolCall") {
    name = item["tool"];
    detail = {
      kind: "mcp",
      server: str(item["server"]),
      tool: str(name),
      arguments: item["arguments"],
    };
  } else if (type === "collabAgentToolCall") {
    name = item["tool"];
    const child = str(list(item["receiverThreadIds"])[0]);
    detail =
      name === "spawnAgent"
        ? {
            kind: "agent.spawn",
            ...(child ? { childAgent: child } : {}),
            prompt: str(item["prompt"]),
          }
        : {
            kind: "agent.message",
            ...(child ? { targetAgent: child } : {}),
            message: str(item["prompt"]),
          };
    title = str(name);
  } else if (type === "plan") detail = { kind: "plan", markdown: str(item["text"]) };
  else if (type === "webSearch") {
    const action = obj(item["action"]);
    detail =
      action["type"] === "search"
        ? {
            kind: "web.search",
            query: str(
              action["query"],
              list(action["queries"])
                .filter((v): v is string => typeof v === "string")
                .join("; "),
            ),
          }
        : { kind: "web.fetch", url: str(action["url"]) };
  } else if (type === "imageView" || type === "imageGeneration") detail = { kind: "image" };
  else if (type === "dynamicToolCall") name = item["tool"];
  return toolDraft(detail, title, item, status, type, name);
}
