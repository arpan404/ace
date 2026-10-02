import { applyDelta, outputDeltas } from "@ace/projection";
import { Item, ItemId, type EventPayload, type ToolDetail } from "@ace/protocol";
import type { Fact, ItemDraft, Key, ToolDetailDraft } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, linkAgent } from "./tree.ts";
import { itemDetailKind, itemInput } from "./item-input.ts";
import { refreshItemIndex } from "./indexes.ts";

function canonicalDetail(
  state: ThreadState,
  key: Key,
  draft: ToolDetailDraft,
  ctx: ApplyContext,
  events: EventPayload[],
): Partial<ToolDetail> | ToolDetailDraft {
  if (draft.kind === "agent.spawn") {
    const { childAgent, ...detail } = draft;
    if (childAgent === undefined) return detail;
    const child = ensureAgent(state, childAgent, ctx, events);
    put(state.itemLinks, key, { ...get(state.itemLinks, key), childAgent });
    return { ...detail, childAgentId: child.agent.id };
  }
  if (draft.kind === "agent.message") {
    const { targetAgent, ...detail } = draft;
    if (targetAgent === undefined) return detail;
    const target = ensureAgent(state, targetAgent, ctx, events);
    put(state.itemLinks, key, { ...get(state.itemLinks, key), targetAgent });
    return { ...detail, targetAgentId: target.agent.id };
  }
  return draft;
}

export function upsertItem(
  state: ThreadState,
  agentKey: Key,
  key: Key,
  draft: ItemDraft,
  ctx: ApplyContext,
  events: EventPayload[],
): Item {
  const record = ensureAgent(state, agentKey, ctx, events);
  const previous = get(state.items, key);
  if (previous && previous.agentId !== record.agent.id)
    throw new Error("item key has a different owner");
  const base = {
    id: previous?.id ?? ItemId.parse(ctx.ids.next("item")),
    agentId: record.agent.id,
    createdAt: previous?.createdAt ?? ctx.now,
    ...(previous?.runId === undefined
      ? previous || record.activeRun === undefined
        ? {}
        : { runId: record.activeRun }
      : { runId: previous.runId }),
  };
  const patch = structuredClone(draft);
  const detail = patch.type === "tool_call" ? patch.call?.detail : undefined;
  const input = itemInput(
    previous,
    base,
    patch,
    ctx.now,
    detail ? canonicalDetail(state, key, detail, ctx, events) : undefined,
  );
  const item = Item.parse(input);
  const legacy =
    itemDetailKind(previous, patch) === "shell" &&
    detail &&
    "output" in detail &&
    typeof detail.output === "string"
      ? detail.output
      : undefined;
  const previousOutput =
    previous?.type === "tool_call" && previous.call.detail.kind === "shell"
      ? previous.call.detail.output
      : undefined;
  if (legacy !== undefined && item.type === "tool_call" && item.call.detail.kind === "shell") {
    if (previousOutput) item.call.detail.output = structuredClone(previousOutput);
    else delete item.call.detail.output;
  }
  put(state.items, key, item);
  refreshItemIndex(state, key);
  emit(events, { type: previous ? "item.updated" : "item.created", item });
  if (legacy !== undefined) {
    const suffix = new TextDecoder().decode(
      new TextEncoder().encode(legacy).subarray(previousOutput?.bytes ?? 0),
    );
    appendDelta(item, "output", suffix, events);
  }
  if (item.type === "tool_call" && item.call.detail.kind === "agent.spawn") {
    const child = get(state.itemLinks, key)?.childAgent;
    if (child !== undefined)
      linkAgent(
        state,
        {
          type: "agent.linked",
          agent: child,
          parent: agentKey,
          spawnedBy: key,
        },
        ctx,
        events,
      );
  }
  return item;
}

/** Unknown items are materialized, so chunks from partial streams survive. */
export function appendItem(
  state: ThreadState,
  fact: Extract<Fact, { type: "item.delta" }>,
  ctx: ApplyContext,
  events: EventPayload[],
): boolean {
  const record = ensureAgent(state, fact.agent, ctx, events);
  let item = get(state.items, fact.item);
  const created = !item;
  if (!item) {
    const draft: ItemDraft =
      fact.field === "reasoning"
        ? { type: "reasoning", text: "" }
        : fact.field === "output"
          ? {
              type: "tool_call",
              call: {
                kind: "shell",
                title: "Output",
                status: "running",
                detail: { kind: "shell", command: "" },
              },
            }
          : { type: "message", role: "assistant", parts: [] };
    item = upsertItem(state, fact.agent, fact.item, draft, ctx, events);
  }
  if (item.agentId !== record.agent.id) throw new Error("item key has a different owner");
  appendDelta(item, fact.field, fact.append, events);
  const activity =
    item.type === "reasoning"
      ? "thinking"
      : item.type === "tool_call"
        ? "tool"
        : item.type === "message" && item.role === "assistant"
          ? "responding"
          : undefined;
  const changed =
    record.activeRun !== undefined &&
    item.runId === record.activeRun &&
    activity !== undefined &&
    record.activity !== activity;
  if (changed) {
    record.activity = activity;
    delete record.detail;
  }
  return created || changed || record.agent.status.state === "unresponsive";
}

function appendDelta(
  item: Item,
  field: "text" | "reasoning" | "output",
  text: string,
  events: EventPayload[],
): void {
  if (!applyDelta(item, field, text))
    throw new Error(`delta ${field} does not apply to ${item.type}`);
  for (const append of field === "output" ? outputDeltas(text) : [text])
    events.push({ type: "item.delta", itemId: item.id, agentId: item.agentId, field, append });
}
