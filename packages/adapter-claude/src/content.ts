import { claudeError } from "./provider-error.ts";
import { raw } from "./native.ts";
import { ClaudeState } from "./state.ts";
import { list, number, object, string, text, type Data } from "./native.ts";
import { matchBlock, type MessageIndex } from "./blocks.ts";
import { childUsage } from "./usage.ts";
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
  const settled = state.terminalChildren.has(agent);
  const item = state.key("tool", id);
  const name = string(block["name"], "Unknown tool");
  const input = object(block["input"]);
  state.toolOwners.set(id, agent);
  const detail = toolDetail(name, input);
  state.toolKinds.set(id, detail.kind);
  state.emit({
    type: "item.upsert",
    agent,
    item,
    draft: {
      type: "tool_call",
      complete: settled,
      call: {
        title: name,
        kind: detail.kind,
        // Late inputs enrich settled tools without replacing their persisted outcome.
        ...(state.settledItem(agent, item)
          ? {}
          : { status: settled ? "cancelled" : awaiting ? "awaiting_approval" : "running" }),
        detail,
        ...state.keepToolRaw(id, frame, name),
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
  messages: MessageIndex,
): void {
  const agent = state.agentFor(data);
  const m = object(data["message"]);
  const role = data["type"] === "assistant" ? "assistant" : "user";
  if (role === "assistant" && typeof m["model"] === "string" && m["model"]) {
    state.emit({ type: "agent.linked", agent, model: m["model"] });
    if (agent === state.root) state.model = m["model"];
  }
  if (role === "assistant")
    state.start(agent, agent === state.root ? (state.wake ?? "unknown") : "spawn");
  const content =
    typeof m["content"] === "string" ? [{ type: "text", text: m["content"] }] : list(m["content"]);
  if (role === "assistant" && content.length > 0) state.contentSeen.add(agent);
  const id = string(m["id"], string(data["uuid"], `${seq}`));
  if (role === "assistant") childUsage(state, agent, id, m);
  if (typeof data["error"] === "string") {
    const error = claudeError(data["error"], text(m["content"]), state.model);
    state.errors.set(agent, error);
    state.emit({
      type: "item.upsert",
      agent,
      item: state.key("error", id),
      draft: {
        type: "notice",
        level: "error",
        code: error.code,
        title: error.title,
        detail: error.detail,
        text: error.message,
        complete: true,
        raw: [raw(data)],
      },
    });
    return;
  }
  const userText = content
    .map(object)
    .filter(
      (block) => block["type"] === "text" && block["text"] !== "[Request interrupted by user]",
    );
  if (role === "user" && userText.length) {
    const item =
      agent !== state.root ? state.key("prompt", agent) : state.key("message", `${agent}:${id}:0`);
    state.emit({
      type: "item.upsert",
      agent,
      item,
      draft: {
        type: "message",
        role: "user",
        parts: userText.map((block) => ({ type: "text" as const, text: string(block["text"]) })),
        complete: true,
        ...(string(data["uuid"]) ? { nativeId: string(data["uuid"]) } : {}),
        ...state.keepMessageRaw(item, data, agent),
      },
    });
  }
  const blocks = messages.forMessage(agent, id);
  for (const [index, value] of content.entries()) {
    const block = object(value);
    const type = string(block["type"]);
    const current = streams.get(agent);
    const blockIndex = matchBlock(
      blocks,
      block,
      index,
      string(data["uuid"]),
      current?.id === id ? current : undefined,
    );
    const messageItem = state.key("message", `${agent}:${id}:${blockIndex}`);
    if (type === "tool_use") {
      const toolId = string(block["id"]);
      if (seq < (state.toolFrames.get(toolId) ?? -1)) continue;
      state.toolFrames.set(toolId, seq);
      tool(state, agent, block, data);
    } else if (type === "tool_result") {
      const toolId = string(block["tool_use_id"]);
      if (!toolId || seq < (state.toolFrames.get(toolId) ?? -1)) continue;
      state.toolFrames.set(toolId, seq);
      const owner = state.toolOwners.get(toolId) ?? agent;
      state.toolOwners.set(toolId, owner);
      const item = state.key("tool", toolId);
      const declined = list(data["tool_result_meta"]).some((nativeMeta) => {
        const meta = object(nativeMeta);
        return meta["id"] === toolId && meta["non_execution_kind"] === "permission-rule";
      });
      state.emit({
        type: "item.upsert",
        agent: owner,
        item,
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            ...(state.settledItem(owner, item)
              ? {}
              : {
                  status: declined
                    ? "declined"
                    : block["is_error"] === true
                      ? "failed"
                      : "succeeded",
                }),
            ...state.keepToolRaw(toolId, data),
          },
        },
      });
      state.emit({
        type: "activity",
        agent: owner,
        activity: "thinking",
      });
      const output = text(block["content"]);
      if (output && state.toolKinds.get(toolId) === "shell")
        state.emit({
          type: "item.delta",
          agent: owner,
          item,
          field: "output",
          append: output,
        });
    } else if (type === "text") {
      const contentText = string(block["text"]);
      if (role === "user" && contentText === "[Request interrupted by user]") {
        state.notice(data, `${seq}`, agent, "info", contentText);
        continue;
      }
      if (role === "user") continue;
      const item = messageItem;
      state.emit({
        type: "item.upsert",
        agent,
        item,
        draft: {
          type: "message",
          ...(list(m["content"]).length === 1 && string(data["uuid"])
            ? { nativeId: string(data["uuid"]) }
            : {}),
          role,
          parts: [{ type: "text", text: contentText }],
          complete: true,
          ...state.keepMessageRaw(item, data, agent),
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
          ...state.keepMessageRaw(messageItem, data, agent),
        },
      });
    else state.notice(data, `${seq}:${index}`, agent);
  }
}
export interface StreamState {
  id: string;
  blocks: Map<number, { kind: string; item: string }>;
  unmatched: Map<string, number[]>;
  cursors: Map<string, number>;
}
export function stream(state: ClaudeState, data: Data, streams: Map<string, StreamState>): void {
  const agent = state.agentFor(data);
  const event = object(data["event"]);
  const type = string(event["type"]);
  if (type === "message_start") {
    streams.set(agent, {
      id: string(object(event["message"])["id"]),
      blocks: new Map(),
      unmatched: new Map(),
      cursors: new Map(),
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
    const indices = current.unmatched.get(kind) ?? [];
    indices.push(index);
    current.unmatched.set(kind, indices);
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
                complete: state.terminalChildren.has(agent),
                ...state.keepMessageRaw(item, data, agent),
              }
            : {
                type: "reasoning",
                text: string(block["thinking"]),
                complete: state.terminalChildren.has(agent),
                ...state.keepMessageRaw(item, data, agent),
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
  const current = streams.get(agent);
  streams.delete(agent);
  for (const block of current?.blocks.values() ?? []) {
    if (block.kind === "text" || block.kind === "thinking")
      state.emit({
        type: "item.upsert",
        agent,
        item: block.item,
        draft: { type: block.kind === "text" ? "message" : "reasoning", complete: true },
      });
  }
}
