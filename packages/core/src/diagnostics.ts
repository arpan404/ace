import { ItemId, type EventPayload, type Item, type RunId } from "@ace/protocol";
import type { AgentRecord, ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";

/** Preserve JSON facts verbatim, and describe values JSON cannot represent. */
export function diagnosticData(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : { unsupported: String(value) };
  if (typeof value !== "object") return { unsupported: typeof value };
  if (seen.has(value)) return { unsupported: "circular reference" };
  if (depth > 100) return { unsupported: "excessive nesting" };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => diagnosticData(entry, seen, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      put(
        result,
        key,
        "value" in descriptor
          ? diagnosticData(descriptor.value, seen, depth + 1)
          : { unsupported: "accessor" },
      );
    }
    return result;
  } catch {
    return { unsupported: "unreadable object" };
  } finally {
    seen.delete(value);
  }
}

function publishNotice(
  state: ThreadState,
  owner: AgentRecord,
  notice: ThreadState["pendingNotices"][number],
  ctx: ApplyContext,
  events: EventPayload[],
  runId?: RunId,
): void {
  const id = ItemId.parse(ctx.ids.next("item"));
  const item: Item = {
    id,
    agentId: owner.agent.id,
    complete: true,
    ...(runId === undefined ? {} : { runId }),
    type: "notice",
    level: "warning",
    ...notice,
  };
  let key = `ace:notice:${id}`;
  while (get(state.items, key)) key += ":";
  put(state.items, key, item);
  emit(events, { type: "item.created", item });
}

/** Rejection never creates agents or refreshes liveness. */
export function rejectFact(
  state: ThreadState,
  input: unknown,
  reason: string,
  ctx: ApplyContext,
): EventPayload[] {
  const events: EventPayload[] = [];
  const notice = {
    createdAt: ctx.now,
    text: `Ignored adapter fact: ${reason}`,
    raw: [{ type: "core.rejected_fact", data: diagnosticData(input) }],
  };
  const owner = state.rootKey === undefined ? undefined : get(state.agents, state.rootKey);
  if (owner) publishNotice(state, owner, notice, ctx, events, owner.activeRun);
  else state.pendingNotices.push(notice);
  return events;
}

/** Deferred warnings join the first root established by valid provider facts. */
export function flushNotices(state: ThreadState, ctx: ApplyContext, events: EventPayload[]): void {
  if (state.pendingNotices.length === 0) return;
  const owner = state.rootKey === undefined ? undefined : get(state.agents, state.rootKey);
  if (!owner) return;
  for (const notice of state.pendingNotices) publishNotice(state, owner, notice, ctx, events);
  state.pendingNotices = [];
}
