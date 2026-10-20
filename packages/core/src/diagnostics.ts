import { ItemId, type EventPayload, type Item, type RunId } from "@ace/protocol";
import { dictionary, type AgentRecord, type ApplyContext, type ThreadState } from "./state.ts";
import type { Key } from "./facts.ts";
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
): Key {
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
  return key;
}

/** A repeated rejection keeps the raw facts of its first few occurrences and counts the rest. */
const repeatRawLimit = 10;

/** Rejection never creates agents or refreshes liveness. */
export function rejectFact(
  state: ThreadState,
  input: unknown,
  reason: string,
  ctx: ApplyContext,
): EventPayload[] {
  const events: EventPayload[] = [];
  const text = `Ignored adapter fact: ${reason}`;
  const raw = { type: "core.rejected_fact", data: diagnosticData(input) };
  const owner = state.rootKey === undefined ? undefined : get(state.agents, state.rootKey);
  if (!owner) {
    state.pendingNotices.push({ createdAt: ctx.now, text, raw: [raw] });
    return events;
  }
  // An adapter that keeps re-sending a fact core cannot accept must not flood the transcript.
  const run = owner.activeRun ?? "";
  if (state.rejectionNotices?.run !== run) state.rejectionNotices = { run, notices: dictionary() };
  const factType =
    input !== null && typeof input === "object" && "type" in input && typeof input.type === "string"
      ? input.type
      : "";
  const signature = `${factType}\u0000${reason}`;
  const repeated = get(state.rejectionNotices.notices, signature);
  const item = repeated && get(state.items, repeated.item);
  if (repeated && item?.type === "notice") {
    repeated.count++;
    item.text = `${text} (${repeated.count} times)`;
    if (item.raw.length < repeatRawLimit) item.raw.push(raw);
    emit(events, { type: "item.updated", item });
    return events;
  }
  const key = publishNotice(
    state,
    owner,
    { createdAt: ctx.now, text, raw: [raw] },
    ctx,
    events,
    owner.activeRun,
  );
  put(state.rejectionNotices.notices, signature, { item: key, count: 1 });
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
