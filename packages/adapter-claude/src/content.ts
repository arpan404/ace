import { ClaudeState } from "./state.ts";
import { list, number, object, raw, string, text, type Data } from "./native.ts";
import { toolDetail } from "./tools.ts";

export function tool(
  state: ClaudeState,
  agent: string,
  block: Data,
  frame: unknown,
  awaiting = false,
): void {
  const id = string(block["id"]);
  if (!id) return;
  const name = string(block["name"], "Unknown tool");
  const input = object(block["input"]);
  state.toolOwners.set(id, agent);
  const detail = toolDetail(name, input);
  state.toolKinds.set(id, detail.kind);
  const child =
    detail.kind === "agent.spawn"
      ? state.child(id, agent, input["run_in_background"] === true)
      : undefined;
  state.emit({
    type: "item.upsert",
    agent,
    item: state.key("tool", id),
    draft: {
      type: "tool_call",
      complete: false,
      call: {
        title: name,
        kind: detail.kind,
        status: awaiting ? "awaiting_approval" : "running",
        detail: child && detail.kind === "agent.spawn" ? { ...detail, childAgent: child } : detail,
        raw: state.keepToolRaw(id, frame, name),
      },
    },
  });
  state.emit({ type: "activity", agent, activity: "tool" });
}
export function message(state: ClaudeState, data: Data, seq: number): void {
  const agent = state.agentFor(data);
  const m = object(data["message"]);
  const role = data["type"] === "assistant" ? "assistant" : "user";
  const content =
    typeof m["content"] === "string" ? [{ type: "text", text: m["content"] }] : list(m["content"]);
  const id = string(m["id"], string(data["uuid"], `${seq}`));
  for (const [index, value] of content.entries()) {
    const block = object(value);
    const type = string(block["type"]);
    if (type === "tool_use") tool(state, agent, block, data);
    else if (type === "tool_result") {
      const toolId = string(block["tool_use_id"]);
      if (!toolId) continue;
      const declined = list(data["tool_result_meta"]).some((value) => {
        const meta = object(value);
        return meta["id"] === toolId && meta["non_execution_kind"] === "permission-rule";
      });
      state.emit({
        type: "item.upsert",
        agent: state.toolOwners.get(toolId) ?? agent,
        item: state.key("tool", toolId),
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            status: declined ? "declined" : block["is_error"] === true ? "failed" : "succeeded",
            raw: state.keepToolRaw(toolId, data),
          },
        },
      });
      const output = text(block["content"]);
      if (output && state.toolKinds.get(toolId) === "shell")
        state.emit({
          type: "item.delta",
          agent,
          item: state.key("tool", toolId),
          field: "output",
          append: output,
        });
    } else if (type === "text") {
      const value = string(block["text"]);
      if (role === "user" && value === "[Request interrupted by user]") {
        state.notice(data, `${seq}`, agent, "info", value);
        continue;
      }
      state.emit({
        type: "item.upsert",
        agent,
        item:
          role === "user" && agent !== state.root
            ? state.key("prompt", agent)
            : state.key("message", `${agent}:${id}:${index}`),
        draft: {
          type: "message",
          role,
          parts: [{ type: "text", text: value }],
          complete: true,
          raw: [raw(data)],
        },
      });
      if (role === "assistant") state.emit({ type: "activity", agent, activity: "responding" });
    } else if (type === "thinking")
      state.emit({
        type: "item.upsert",
        agent,
        item: state.key("message", `${agent}:${id}:${index}`),
        draft: {
          type: "reasoning",
          text: string(block["thinking"]),
          complete: true,
          raw: [raw(data)],
        },
      });
    else state.notice(data, `${seq}:${index}`, agent);
  }
  if (typeof data["error"] === "string") {
    const error = data["error"];
    // Provider error metadata is authoritative. Ordinary prose mentioning auth is not.
    state.notice(data, `error:${seq}`, agent, "error", error);
  }
}
export interface StreamState {
  id: string;
  blocks: Map<number, { kind: string; item: string }>;
}
export function stream(state: ClaudeState, data: Data, streams: Map<string, StreamState>): void {
  const agent = state.agentFor(data);
  const event = object(data["event"]);
  const type = string(event["type"]);
  if (type === "message_start") {
    streams.set(agent, { id: string(object(event["message"])["id"]), blocks: new Map() });
    return;
  }
  const current = streams.get(agent);
  if (!current) return;
  const index = number(event["index"]);
  const item = state.key("message", `${agent}:${current.id}:${index}`);
  if (type === "content_block_start") {
    const block = object(event["content_block"]);
    const kind = string(block["type"]);
    current.blocks.set(index, { kind, item });
    if (kind === "text" || kind === "thinking") {
      state.emit({
        type: "item.upsert",
        agent,
        item,
        draft:
          kind === "text"
            ? {
                type: "message",
                role: "assistant",
                parts: [{ type: "text", text: string(block["text"]) }],
                complete: false,
                raw: [raw(data)],
              }
            : {
                type: "reasoning",
                text: string(block["thinking"]),
                complete: false,
                raw: [raw(data)],
              },
      });
      state.emit({
        type: "activity",
        agent,
        activity: kind === "text" ? "responding" : "thinking",
      });
    }
  } else if (type === "content_block_delta") {
    const block = current.blocks.get(index);
    const delta = object(event["delta"]);
    if (block?.kind === "text" || block?.kind === "thinking")
      state.emit({
        type: "item.delta",
        agent,
        item,
        field: block.kind === "text" ? "text" : "reasoning",
        append: string(delta["text"], string(delta["thinking"])),
      });
  } else if (type === "content_block_stop") {
    const block = current.blocks.get(index);
    if (block?.kind === "text" || block?.kind === "thinking")
      state.emit({
        type: "item.upsert",
        agent,
        item,
        draft: { type: block.kind === "text" ? "message" : "reasoning", complete: true },
      });
  }
}
