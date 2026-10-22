import type { SidebarReader } from "@ace/client";
import type { InboxThread } from "@ace/ui-core/mobile";
import { inboxLayout, inboxRow, type InboxClock, type RowContext } from "./inbox-rows.ts";

/** At most this many rows are kept: more than a phone screen scrolls through at launch. */
export const checkpointRows = 300;
/** A burst of changes writes once, this long after the last of them. */
export const checkpointDelayMs = 2_000;

/**
 * The inbox as the phone draws it at its next launch, before this runtime starts: the same
 * patches the live inbox sends (a reset naming the kept rows, each row, the sections), with
 * every thread read as an unconfirmed copy, so a finished thread reads Syncing rather than
 * Done until the daemon confirms it again. Unsent sends stay out: the durable outbox restores
 * them. Rows are kept in the order the inbox shows them, up to `checkpointRows`.
 */
export function inboxCheckpoint(
  store: SidebarReader,
  context: RowContext,
): Record<string, unknown>[] {
  const held: InboxThread[] = [];
  for (const id of store.ids) {
    const entry = store.thread(id);
    if (entry) held.push({ key: id, machineId: context.machineId, entry, unconfirmed: true });
  }
  const layout = inboxLayout(held, [], context.now, (store.homeWindow ?? store.window)?.before != null);
  const kept = new Set<string>();
  for (const section of layout.sections)
    for (const id of section.ids) if (kept.size < checkpointRows) kept.add(id);
  const sections = layout.sections
    .map((section) => {
      const indices = section.ids.flatMap((id, index) => (kept.has(id) ? [index] : []));
      return {
        ...section,
        ids: indices.map((index) => section.ids[index]),
        ranks: indices.map((index) => section.ranks[index]),
      };
    })
    .filter((section) => section.ids.length > 0);
  const rows = held
    .filter((thread) => kept.has(thread.key))
    .map((thread) => ({
      type: "inbox.row",
      id: thread.key,
      row: { ...inboxRow(thread, context), confirmed: false, generation: 0 },
    }));
  return [{ type: "inbox.reset", ids: [...kept] }, ...rows, { ...layout, sections }];
}

/**
 * Writes the checkpoint a while after the confirmed list last changed. `touch` is called on every
 * change; `confirmed` says whether the list is the daemon's current one, since only that is worth
 * keeping. Returns how to stop.
 */
export function followCheckpoint(
  clock: InboxClock,
  confirmed: () => boolean,
  read: () => Record<string, unknown>[],
  save: (json: string) => void,
) {
  let cancel: (() => void) | undefined;
  return {
    touch() {
      if (!confirmed()) return;
      cancel?.();
      cancel = clock.set(checkpointDelayMs, () => {
        cancel = undefined;
        if (!confirmed()) return;
        try {
          save(JSON.stringify(read()));
        } catch {
          // An optional cache: a write that fails leaves the previous launch's copy.
        }
      });
    },
    stop() {
      cancel?.();
      cancel = undefined;
    },
  };
}
