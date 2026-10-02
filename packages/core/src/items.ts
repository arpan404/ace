import { Item, ItemId, type EventPayload, type ToolDetail } from "@ace/protocol";
import type { Fact, ItemDraft, Key, ToolDetailDraft } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, linkAgent } from "./tree.ts";

function canonicalDetail(
  state: ThreadState,
  key: Key,
  draft: ToolDetailDraft,
  ctx: ApplyContext,
  events: EventPayload[],
): Partial<ToolDetail> {
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
  let input: unknown;
  if (patch.type === "tool_call") {
    const priorCall = previous?.type === "tool_call" ? previous.call : undefined;
    const detail = patch.call?.detail;
    const kind = patch.call?.kind ?? detail?.kind ?? priorCall?.kind ?? "custom";
    const mergedDetail = {
      ...(priorCall?.detail.kind === (detail?.kind ?? kind) ? priorCall.detail : { kind }),
      ...(detail ? canonicalDetail(state, key, detail, ctx, events) : {}),
    };
    input = {
      ...(previous?.type === patch.type ? previous : { complete: false }),
      ...patch,
      ...base,
      call: {
        title: kind,
        status: "pending",
        startedAt: ctx.now,
        raw: [],
        ...priorCall,
        ...patch.call,
        id: base.id,
        agentId: base.agentId,
        kind,
        detail: mergedDetail,
      },
    };
  } else {
    const defaults =
      patch.type === "message"
        ? { role: "assistant", parts: [] }
        : patch.type === "reasoning"
          ? { text: "" }
          : patch.type === "notice"
            ? { level: "info", text: "" }
            : {};
    input = {
      complete: false,
      ...defaults,
      ...(previous?.type === patch.type ? previous : {}),
      ...patch,
      ...base,
    };
  }
  const item = Item.parse(input);
  put(state.items, key, item);
  emit(events, { type: previous ? "item.updated" : "item.created", item });
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
                detail: { kind: "shell", command: "", output: "" },
              },
            }
          : { type: "message", role: "assistant", parts: [] };
    item = upsertItem(state, fact.agent, fact.item, draft, ctx, events);
  }
  if (item.agentId !== record.agent.id) throw new Error("item key has a different owner");
  if (fact.field === "output" && item.type === "tool_call" && item.call.detail.kind === "shell") {
    item.call.detail.output = (item.call.detail.output ?? "") + fact.append;
  } else if (
    (fact.field === "reasoning" || fact.field === "text") &&
    (item.type === "reasoning" || item.type === "notice")
  ) {
    item.text += fact.append;
  } else if (fact.field === "text" && item.type === "message") {
    const last = item.parts.at(-1);
    if (last?.type === "text") last.text += fact.append;
    else item.parts.push({ type: "text", text: fact.append });
  } else {
    throw new Error(`delta ${fact.field} does not apply to ${item.type}`);
  }
  events.push({
    type: "item.delta",
    itemId: item.id,
    agentId: item.agentId,
    field: fact.field,
    append: fact.append,
  });
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
