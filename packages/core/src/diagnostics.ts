import { ItemId, type EventPayload, type Item } from "@ace/protocol";
import type { ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, ensureInitialRoot } from "./tree.ts";

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

/** A rejected fact has exactly one diagnostic and leaves existing work untouched. */
export function rejectFact(
  state: ThreadState,
  input: unknown,
  reason: string,
  ctx: ApplyContext,
): EventPayload[] {
  const events: EventPayload[] = [];
  ensureInitialRoot(state, ctx, events);
  const owner = ensureAgent(state, state.rootKey ?? "ace:diagnostics", ctx, events);
  const id = ItemId.parse(ctx.ids.next("item"));
  const item: Item = {
    id,
    agentId: owner.agent.id,
    createdAt: ctx.now,
    complete: true,
    ...(owner.activeRun === undefined ? {} : { runId: owner.activeRun }),
    type: "notice",
    level: "warning",
    text: `Ignored adapter fact: ${reason}`,
    raw: [{ type: "core.rejected_fact", data: diagnosticData(input) }],
  };
  let key = `ace:notice:${id}`;
  while (get(state.items, key)) key += ":";
  put(state.items, key, item);
  emit(events, { type: "item.created", item });
  return events;
}
