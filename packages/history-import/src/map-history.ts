import { sanitizeUserText } from "./user-text.ts";
import { historyToolDetail } from "./tool-detail.ts";
import { Item, ItemId, type AgentId, type RawPayload } from "@ace/protocol";
import { object, string, timestamp } from "@ace/native-session";
import type { HistoryProvider } from "@ace/protocol/history";

export type MappingContext = {
  provider: HistoryProvider;
  agentId: AgentId;
  idPrefix: string;
  at: number;
  raw: RawPayload;
  resultCall?: (id: string) => ItemId | undefined;
};
export type Mapped = { item: Item; message: boolean };
/** File transcripts differ from live notifications. Preserve unsupported blocks as notices. */
export function* mapHistory(value: unknown, ctx: MappingContext): Generator<Mapped> {
  const r = object(value);
  const p = ctx.provider === "codex" && r.type === "response_item" ? object(r.payload) : r;
  const message = ctx.provider === "claude" ? object(p.message) : p;
  const role =
    string(message.role) ?? (p.type === "user" || p.type === "assistant" ? p.type : undefined);
  const at = timestamp(r.timestamp) ?? timestamp(object(p.time).created) ?? ctx.at;
  let seq = 0;
  let linkedCall: ItemId | undefined;
  let rawTaken = false;
  const raw = () => {
    if (rawTaken) return [];
    rawTaken = true;
    return [ctx.raw];
  };
  const base = () => ({
    id: ItemId.parse(`${ctx.idPrefix}:${seq++}`),
    agentId: ctx.agentId,
    createdAt: at,
    complete: true,
  });
  const notice = (text: string): Mapped => ({
    item: Item.parse({
      ...base(),
      type: "notice",
      level: "info",
      ...(linkedCall ? { toolCallId: linkedCall } : {}),
      text: text.slice(0, 4096),
      raw: raw(),
    }),
    message: false,
  });
  const texts = function* (
    type: "message" | "reasoning" | "notice",
    text: string,
    isMessage: boolean,
  ): Generator<Mapped> {
    if (role === "user") {
      text = sanitizeUserText(text);
      if (!text) return;
    }
    // Bounded text items also bound event and page sizes after importing a large native block.
    for (let offset = 0; offset < text.length || offset === 0; offset += 4096) {
      const chunk = text.slice(offset, offset + 4096);
      yield {
        item: Item.parse(
          type === "message"
            ? {
                ...base(),
                type,
                role: role === "user" ? "user" : "assistant",
                parts: [{ type: "text", text: chunk }],
                raw: raw(),
              }
            : type === "notice"
              ? {
                  ...base(),
                  type,
                  level: "info",
                  text: chunk,
                  raw: raw(),
                  ...(linkedCall ? { toolCallId: linkedCall } : {}),
                }
              : { ...base(), type, text: chunk, raw: raw() },
        ),
        message: isMessage && offset === 0,
      };
    }
  };
  const tool = (block: Record<string, unknown>): Mapped => {
    const b = base();
    const state = object(block.state);
    const detail = historyToolDetail(block);
    const status =
      state.status === "error"
        ? "failed"
        : state.status === "completed"
          ? "succeeded"
          : state.status === "running"
            ? "running"
            : "pending";
    return {
      item: Item.parse({
        ...b,
        type: "tool_call",
        call: {
          id: b.id,
          agentId: ctx.agentId,
          kind: detail.kind,
          title: (string(block.name) ?? string(block.tool) ?? "Native tool").slice(0, 256),
          status,
          detail,
          startedAt: at,
          raw: raw(),
        },
      }),
      message: false,
    };
  };
  if (ctx.provider === "codex") {
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      yield tool(p);
      return;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const nativeId = string(p.call_id);
      linkedCall = nativeId ? ctx.resultCall?.(nativeId) : undefined;
      const output = string(p.output);
      if (output) yield* texts("notice", output, false);
      else yield notice("Native tool result");
      return;
    }
    if (p.type === "reasoning") {
      for (const part of Array.isArray(p.summary) ? p.summary : []) {
        const text = string(object(part).text);
        if (text) yield* texts("reasoning", text, false);
      }
      yield notice("Native reasoning record");
      return;
    }
    if (r.type === "compacted") {
      yield { item: Item.parse({ ...base(), type: "compaction" }), message: false };
      yield notice("Native compaction record");
      return;
    }
  }
  if (ctx.provider === "opencode" && p.type === "tool") {
    const call = tool(p);
    yield call;
    linkedCall = call.item.id;
    const output = string(object(p.state).output);
    if (output) yield* texts("notice", output, false);
    return;
  }
  if (p.type === "reasoning" || p.type === "thinking") {
    yield* texts("reasoning", string(p.text) ?? string(p.thinking) ?? "", false);
    return;
  }
  if (ctx.provider === "opencode" && p.type === "text") {
    if (p.synthetic !== true) yield* texts("message", string(p.text) ?? "", false);
    return;
  }
  if (role === "user" && (p.isMeta === true || p.synthetic === true)) return;
  let content = message.content ?? p.content ?? (role === "user" ? p.text : undefined);
  if (
    ctx.provider === "opencode" &&
    (role === "user" || role === "assistant") &&
    content === undefined
  ) {
    const entry = notice("Native message");
    entry.message = true;
    yield entry;
    return;
  }
  if (role === "user" || role === "assistant") {
    if (typeof content === "string") {
      yield* texts("message", content, true);
      return;
    }
    if (Array.isArray(content)) {
      let counted = false;
      for (const part of content) {
        const block = object(part);
        const text = string(block.text);
        if (
          text &&
          (block.type === "text" || block.type === "input_text" || block.type === "output_text")
        ) {
          yield* texts("message", text, !counted);
          counted = true;
        } else if (block.type === "reasoning")
          yield* texts("reasoning", string(block.text) ?? "", false);
        else if (block.type === "tool") {
          const call = tool(block);
          yield call;
          linkedCall = call.item.id;
          const state = object(block.state);
          const output = string(state.output);
          if (output) yield* texts("notice", output, false);
          for (const result of Array.isArray(state.content) ? state.content : []) {
            const resultText = string(object(result).text);
            if (resultText) yield* texts("notice", resultText, false);
            else yield notice(`Native tool content: ${string(object(result).type) ?? "unknown"}`);
          }
        } else if (block.type === "thinking")
          yield* texts("reasoning", string(block.thinking) ?? "", false);
        else if (block.type === "tool_use") yield tool(block);
        else if (block.type === "tool_result") {
          const nativeId = string(block.tool_use_id);
          linkedCall = nativeId ? ctx.resultCall?.(nativeId) : undefined;
          const result = string(block.content);
          if (result) yield* texts("notice", result, false);
          else yield notice("Native tool result");
        } else yield notice(`Native content block: ${string(block.type) ?? "unknown"}`);
      }
      // Count native messages even if their only content is tools or attachments.
      if (!counted) {
        const entry = notice("Native message");
        entry.message = true;
        yield entry;
      }
      return;
    }
  }
  if (ctx.provider === "opencode" && p.type === "compaction") {
    yield { item: Item.parse({ ...base(), type: "compaction" }), message: false };
    return;
  }
  if (ctx.provider === "claude" && p.type === "system" && p.subtype === "compact_boundary") {
    yield { item: Item.parse({ ...base(), type: "compaction" }), message: false };
  }
  yield notice(`Native history record: ${string(p.type) ?? string(r.type) ?? "unknown"}`);
}
