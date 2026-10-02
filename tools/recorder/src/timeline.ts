import { readFileSync } from "node:fs";
import type { Frame } from "./recording.ts";

/**
 * Print a compact timeline of a recording: one line per frame, consecutive
 * frames with the same label collapsed. Usage: node timeline.ts <file.jsonl>
 */
type Json = Record<string, unknown>;

const NOISE = new Set([
  "sse server.heartbeat",
  "sse sync",
  "sse plugin.added",
  "sse catalog.updated",
  "sse reference.updated",
  "sse integration.updated",
]);

function str(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(frame: Frame): { label: string; detail: string } {
  const data = (frame.data ?? {}) as Json;
  switch (frame.channel) {
    case "stdio": {
      const method = data["method"] as string | undefined;
      const params = (data["params"] ?? {}) as Json;
      if (!method)
        return {
          label: data["error"] ? "response:error" : "response",
          detail: str(data["result"] ?? data["error"]),
        };
      const update = (params["update"] ?? {}) as Json;
      const kind = update["sessionUpdate"] as string | undefined;
      const label = kind ? `${method}:${kind}` : method;
      const thread = (params["threadId"] ?? params["sessionId"]) as string | undefined;
      const item = (params["item"] ?? {}) as Json;
      const bits = [
        thread ? `@${thread.slice(-6)}` : "",
        item["type"] ? `item=${String(item["type"])}` : "",
        kind ? str({ ...update, sessionUpdate: undefined }, 160) : "",
        method.includes("status") || method.startsWith("turn/")
          ? str(params["status"] ?? params["turn"], 120)
          : "",
      ];
      return { label, detail: bits.filter(Boolean).join(" ") };
    }
    case "sse": {
      const payload = (data["payload"] ?? {}) as Json;
      const props = (payload["properties"] ?? {}) as Json;
      const part = (props["part"] ?? {}) as Json;
      const state = (part["state"] ?? {}) as Json;
      const session = (props["sessionID"] ?? part["sessionID"]) as string | undefined;
      const detail = [
        session ? `@${session.slice(-6)}` : "",
        props["status"] ? str(props["status"], 100) : "",
        part["type"]
          ? `part=${String(part["type"])}${part["tool"] ? `:${String(part["tool"])}` : ""}${state["status"] ? `/${String(state["status"])}` : ""}`
          : "",
        (props["info"] as Json | undefined)?.["parentID"]
          ? `parent=${String((props["info"] as Json)["parentID"]).slice(-6)}`
          : "",
      ];
      return {
        label: `sse ${String(payload["type"] ?? data["type"])}`,
        detail: detail.filter(Boolean).join(" "),
      };
    }
    case "sdk": {
      const subtype = data["subtype"] ? `/${String(data["subtype"])}` : "";
      const parent = data["parent_tool_use_id"]
        ? `parent=${String(data["parent_tool_use_id"]).slice(-6)}`
        : "";
      const event = (data["event"] ?? {}) as Json;
      const message = (data["message"] ?? {}) as Json;
      const content = Array.isArray(message["content"]) ? (message["content"] as Json[]) : [];
      const blocks = content
        .map((b) =>
          b["type"] === "tool_use" ? `tool_use:${String(b["name"])}` : String(b["type"]),
        )
        .join(",");
      const extra =
        data["type"] === "stream_event"
          ? String(event["type"])
          : data["type"] === "system"
            ? str(
                {
                  ...data,
                  type: undefined,
                  subtype: undefined,
                  uuid: undefined,
                  session_id: undefined,
                },
                160,
              )
            : blocks;
      return {
        label: `sdk ${String(data["type"])}${subtype}`,
        detail: [parent, extra].filter(Boolean).join(" "),
      };
    }
    case "can_use_tool":
      return {
        label: `can_use_tool ${frame.dir}`,
        detail: str(data["toolName"] ?? data["result"], 120),
      };
    case "http":
      return {
        label: `http ${String(data["method"])} ${String(data["path"])
          .replace(/ses_\w+/, "ses_*")
          .replace(/(per|que)_\w+/, "$1_*")}`,
        detail: data["status"] ? String(data["status"]) : str(data["body"], 100),
      };
    default:
      return { label: `${frame.channel}`, detail: str(frame.data, 160) };
  }
}

const [, , file] = process.argv;
if (!file) throw new Error("usage: timeline.ts <recording.jsonl>");
const lines = readFileSync(file, "utf8").trim().split("\n");
console.log(lines[0]);
let previous = "";
let repeat = 0;
for (const line of lines.slice(1)) {
  const frame = JSON.parse(line) as Frame;
  const { label, detail } = describe(frame);
  const key = `${frame.dir} ${label}`;
  if (NOISE.has(label)) continue;
  if (key === previous && /delta|chunk|stream_event|outputDelta/.test(label)) {
    repeat++;
    continue;
  }
  if (repeat) console.log(`        … ×${repeat} more`);
  repeat = 0;
  previous = key;
  console.log(`${String(frame.t).padStart(7)} ${frame.dir.padEnd(6)} ${label} ${detail}`);
}
if (repeat) console.log(`        … ×${repeat} more`);
