import type { SidebarSource } from "@ace/client";
import { useClient, useSidebarStore } from "@ace/client-react";
import { isRemoved, isSettled, settledFirstRows, settledMoreRows } from "@ace/ui-core";
import { useState } from "react";

/** Each "Show more" asks the daemon for at most this many pages before it stops. */
const pagesPerReveal = 4;

/** Settled threads the store holds, as the daemon pages them: not pinned, not removed. */
function loadedSettled(store: SidebarSource): number {
  let count = 0;
  for (const id of store.ids) {
    const entry = store.thread(id);
    if (entry && entry.pinned !== true && !isRemoved(entry) && isSettled(entry)) count++;
  }
  return count;
}

interface Reveal {
  /** What the count belongs to: the project filter and whether the section is open. */
  key: string;
  shown: number;
  loading: boolean;
  error: boolean;
}

/**
 * How much of the open Settled section shows: its first rows, then each "Show more" reveals the
 * next batch, loading older pages from the daemon as the batch needs them. Closing the section
 * or changing the project filter starts again from the first rows.
 */
export function useSettledPaging(project: string | null, open: boolean) {
  const client = useClient();
  const store = useSidebarStore();
  const key = `${project ?? ""}:${open}`;
  const first: Reveal = { key, shown: settledFirstRows, loading: false, error: false };
  const [held, setReveal] = useState<Reveal>(first);
  const reveal = held.key === key ? held : first;
  if (held.key !== key) setReveal(first);
  const update = (patch: Partial<Reveal>) =>
    setReveal((current) => (current.key === key ? { ...current, ...patch } : current));
  const more = async () => {
    if (reveal.loading || !store) return;
    const target = reveal.shown + settledMoreRows;
    update({ shown: target, loading: true, error: false });
    try {
      for (
        let pages = 0;
        // Only Home's own window pages settled threads; the archive's pages archived ones.
        pages < pagesPerReveal &&
        store.window === store.homeWindow &&
        store.window?.before &&
        loadedSettled(store) < target;
        pages++
      )
        await client.threadsMore();
      update({ loading: false });
    } catch {
      // Show what did arrive; a retry asks for the next batch from there.
      const arrived = Math.min(target, Math.max(reveal.shown, loadedSettled(store)));
      update({ shown: arrived, loading: false, error: true });
    }
  };
  return { shown: reveal.shown, loading: reveal.loading, error: reveal.error, more };
}
