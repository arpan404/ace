import type { ItemDraft, Key } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import type { EventPayload, Item } from "@ace/protocol";
import { get } from "./emit.ts";
import { upsertItem } from "./items.ts";
/** Native snapshots reconcile against canonical state, never against evictable adapter hints. */
export function reconcileItem(
  state: ThreadState,
  agent: Key,
  key: Key,
  draft: ItemDraft,
  ctx: ApplyContext,
  events: EventPayload[],
): Item {
  const previous = get(state.items, key);
  if (previous?.complete && draft.complete === false) return previous;
  if (draft.type !== "tool_call" || previous?.type !== "tool_call")
    return upsertItem(state, agent, key, draft, ctx, events);
  const first = previous.call.raw[0];
  const call = { ...draft.call };
  if (first && call.raw?.length) call.raw = [first, ...call.raw.slice(-1)];
  const incoming = call.detail;
  const prior = previous.call.detail;
  if (incoming?.kind === "shell" && prior.kind === "shell" && incoming.output !== undefined) {
    const current = prior.output ?? "";
    const aggregate = incoming.output;
    // A replayed prefix cannot erase output that arrived after the original completion.
    call.detail = { ...incoming, output: current.startsWith(aggregate) ? current : aggregate };
  }
  return upsertItem(state, agent, key, { ...draft, call }, ctx, events);
}
