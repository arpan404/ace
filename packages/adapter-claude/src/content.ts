import { ClaudeState } from "./state.ts";
import { list, number, object, string, text, type Data } from "./native.ts";
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
export function message(
  state: ClaudeState,
  data: Data,
  seq: number,
  streams: Map<string, StreamState>,
): void {
  const agent = state.agentFor(data);
  const m = object(data["message"]);
  const role = data["type"] === "assistant" ? "assistant" : "user";
  if (role === "assistant")
    state.start(agent, agent === state.root ? (state.wake ?? "unknown") : "spawn");
  const content =
    typeof m["content"] === "string" ? [{ type: "text", text: m["content"] }] : list(m["content"]);
  if (role === "assistant" && content.length > 0) state.contentSeen.add(agent);
  const id = string(m["id"], string(data["uuid"], `${seq}`));
  for (const [index, value] of content.entries()) {
    const block = object(value);
    const type = string(block["type"]);
    const current = streams.get(agent);
    const streamed =
      current?.id === id
        ? [...current.blocks].find(([i, entry]) => entry.kind === type && !current.finalized.has(i))
        : undefined;
    const blockIndex = streamed?.[0] ?? index;
    if (streamed) current?.finalized.add(blockIndex);
    const messageItem = state.key("message", `${agent}:${id}:${blockIndex}`);
    if (type === "tool_use") tool(state, agent, block, data);
    else if (type === "tool_result") {
      const toolId = string(block["tool_use_id"]);
      if (!toolId) continue;
      const declined = list(data["tool_result_meta"]).some((nativeMeta) => {
        const meta = object(nativeMeta);
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
      state.emit({
        type: "activity",
        agent: state.toolOwners.get(toolId) ?? agent,
        activity: "thinking",
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
      const contentText = string(block["text"]);
      if (role === "user" && contentText === "[Request interrupted by user]") {
        state.notice(data, `${seq}`, agent, "info", contentText);
        continue;
      }
      const item =
        role === "user" && agent !== state.root ? state.key("prompt", agent) : messageItem;
      state.emit({
        type: "item.upsert",
        agent,
        item,
        draft: {
          type: "message",
          role,
          parts: [{ type: "text", text: contentText }],
          complete: true,
          raw: state.keepMessageRaw(item, data),
        },
      });
      if (role === "assistant") state.emit({ type: "activity", agent, activity: "responding" });
    } else if (type === "thinking")
      state.emit({
        type: "item.upsert",
        agent,
        item: messageItem,
        draft: {
          type: "reasoning",
          text: string(block["thinking"]),
          complete: true,
          raw: state.keepMessageRaw(messageItem, data),
        },
      });
    else state.notice(data, `${seq}:${index}`, agent);
  }
  if (typeof data["error"] === "string") {
    const error = data["error"];
    // Provider error metadata is authoritative. Ordinary prose mentioning auth is not.
    state.errors.set(agent, {
      kind:
        error === "authentication_failed"
          ? "auth"
          : error === "billing_error" || error === "rate_limit"
            ? "quota"
            : "provider",
      message: text(m["content"]) || error,
    });
    state.notice(data, `error:${seq}`, agent, "error", error);
  }
}
export interface StreamState {
  id: string;
  blocks: Map<number, { kind: string; item: string }>;
  finalized: Set<number>;
}
export function stream(state: ClaudeState, data: Data, streams: Map<string, StreamState>): void {
  const agent = state.agentFor(data);
  const event = object(data["event"]);
  const type = string(event["type"]);
  if (type === "message_start") {
    streams.set(agent, {
      id: string(object(event["message"])["id"]),
      blocks: new Map(),
      finalized: new Set(),
    });
    return;
  }
  const current = streams.get(agent);
  if (!current) return;
  const index = number(event["index"]);
  const item = state.key("message", `${agent}:${current.id}:${index}`);
  if (type === "content_block_start") {
    const block = object(event["content_block"]);
    const kind = string(block["type"]);
    state.contentSeen.add(agent);
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
                raw: state.keepMessageRaw(item, data),
              }
            : {
                type: "reasoning",
                text: string(block["thinking"]),
                complete: false,
                raw: state.keepMessageRaw(item, data),
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

export function finishStream(
  state: ClaudeState,
  streams: Map<string, StreamState>,
  agent: string,
): void {
  for (const block of streams.get(agent)?.blocks.values() ?? []) {
    if (block.kind === "text" || block.kind === "thinking")
      state.emit({
        type: "item.upsert",
        agent,
        item: block.item,
        draft: { type: block.kind === "text" ? "message" : "reasoning", complete: true },
      });
  }
}
