import type { LocalStore } from "../store.ts";
import type { ReviewDraft } from "./drafts.ts";
import type { LineRange } from "./file-diff.tsx";

/** Unfinished content and its selection evidence outlive the annotation and Changes tab. */
export interface ReviewComposition {
  id: string;
  threadId: string;
  file: string;
  range: LineRange;
  key?: string;
  version: string;
  needsReselection: boolean;
  fingerprint: ReviewDraft["fingerprint"];
  source: ReviewDraft["source"];
  text: string;
  suggestion: string | undefined;
}

export interface Compositions {
  entries: ReadonlyMap<string, ReviewComposition>;
  active: ReadonlyMap<string, string>;
}

export function beginComposition(store: LocalStore<Compositions>, entry: ReviewComposition): void {
  store.set((previous) => ({
    entries: new Map(previous.entries).set(entry.id, entry),
    active: new Map(previous.active).set(entry.threadId, entry.id),
  }));
}

export function updateComposition(
  store: LocalStore<Compositions>,
  id: string,
  change: Partial<Omit<ReviewComposition, "id" | "threadId" | "key">>,
): void {
  store.set((previous) => {
    const entry = previous.entries.get(id);
    return entry
      ? { ...previous, entries: new Map(previous.entries).set(id, { ...entry, ...change }) }
      : previous;
  });
}

export function finishComposition(store: LocalStore<Compositions>, id: string): void {
  store.set((previous) => {
    const entry = previous.entries.get(id);
    const entries = new Map(previous.entries);
    const active = new Map(previous.active);
    entries.delete(id);
    if (entry && active.get(entry.threadId) === id) active.delete(entry.threadId);
    return { entries, active };
  });
}
