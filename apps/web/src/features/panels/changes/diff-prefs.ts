import { useCallback, useState } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { LocalStore, useLocal } from "../store.ts";

/**
 * How diffs draw, chosen once on this device for every diff viewer: the Changes panel and a
 * pull request's Code tab read and write the same choices.
 */
export interface DiffPrefs {
  /** `auto` is unified in a narrow view and split where both sides fit. */
  mode: "auto" | "unified" | "split";
  wrap: boolean;
  /** The changed-files tree beside the diff. */
  tree: boolean;
  /** Unchanged runs between changes fold behind "Show N unchanged lines". */
  fold: boolean;
  /** Spaces and tabs draw as visible marks. */
  whitespace: boolean;
}

export const defaultDiffPrefs: DiffPrefs = {
  mode: "auto",
  wrap: false,
  tree: true,
  fold: true,
  whitespace: false,
};

const key = "ace.review.prefs";
// Each choice is read on its own, so one bad or missing value keeps the others.
const Stored = z.object({
  mode: z.catch(z.enum(["auto", "unified", "split"]), defaultDiffPrefs.mode),
  wrap: z.catch(z.boolean(), defaultDiffPrefs.wrap),
  tree: z.catch(z.boolean(), defaultDiffPrefs.tree),
  fold: z.catch(z.boolean(), defaultDiffPrefs.fold),
  whitespace: z.catch(z.boolean(), defaultDiffPrefs.whitespace),
});

/** One store per storage, so every viewer on the page sees a change at once. */
const stores = new WeakMap<KeyValueStorage, LocalStore<DiffPrefs>>();

/** The diff preferences kept in `storage`, read from it once and written back on each change. */
export function diffPrefsStore(storage: KeyValueStorage): LocalStore<DiffPrefs> {
  const existing = stores.get(storage);
  if (existing) return existing;
  const store = new LocalStore(readJson(storage, key, Stored, defaultDiffPrefs));
  store.subscribe(() => writeJson(storage, key, store.get()));
  stores.set(storage, store);
  return store;
}

const identity = (prefs: DiffPrefs) => prefs;

/** This device's diff preferences, and a setter that keeps each change for every viewer. */
export function useDiffPrefs(): [DiffPrefs, (change: Partial<DiffPrefs>) => void] {
  const { storage } = useLayout();
  // Without storage (some tests), the choices live as long as this view.
  const [unstored] = useState(() => new LocalStore(defaultDiffPrefs));
  const store = storage ? diffPrefsStore(storage) : unstored;
  const prefs = useLocal(store, identity);
  const change = useCallback(
    (next: Partial<DiffPrefs>) => store.set((previous) => ({ ...previous, ...next })),
    [store],
  );
  return [prefs, change];
}
