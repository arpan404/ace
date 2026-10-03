import type { ItemDraft, Key } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import type { EventPayload, Item } from "@ace/protocol";
import { get } from "./emit.ts";
import { upsertItem } from "./items.ts";
import { extendsOutput } from "./output-snapshot.ts";
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
  const detail = call.detail;
  if (
    detail?.kind === "shell" &&
    previous.call.detail.kind === "shell" &&
    typeof detail.output === "string" &&
    !extendsOutput(previous.call.detail.output, detail.output)
  ) {
    // Missing native chunks cannot be inserted into an append-only stream. Keep the complete
    // aggregate in raw while preserving verified output, including chunks after completion.
    const { output: _output, ...metadata } = detail;
    call.detail = metadata;
  }
  // The core stream writer appends only aggregate bytes beyond its bounded summary.
  return upsertItem(state, agent, key, { ...draft, call }, ctx, events);
}
