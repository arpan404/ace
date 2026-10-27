import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";
import {
  readViewed,
  settleDraft,
  storedViewed,
  StoredDraft,
  withViewed,
  type ReviewDraft,
} from "@ace/ui-core/review";
import type { DiffPrefs, PanelServices, ViewedFiles } from "../services.ts";
import type { LocalStore } from "../store.ts";
import { persistDrafts } from "./draft-persistence.ts";

/*
 * The Changes tab's local state outlives a reload: unsent and sent comments (a review in
 * progress must never vanish because the window closed), the diff layout, and which files were
 * marked viewed. Everything read back is parsed; anything malformed is dropped, not trusted.
 */

const keys = {
  prefs: "ace.review.prefs",
  viewed: "ace.review.viewed",
};

const Prefs = z.object({
  mode: z.catch(z.enum(["auto", "unified", "split"]), "auto"),
  wrap: z.catch(z.boolean(), false),
  tree: z.catch(z.boolean(), true),
});

/** Storage holds JSON from an older build or another tab: parsed by each `read` below. */
const json = { safeParse: (data: unknown) => ({ success: true as const, data }) };

function persist<T>(
  store: LocalStore<T>,
  storage: KeyValueStorage,
  key: string,
  read: (stored: unknown) => T | undefined,
  save: (value: T) => unknown,
) {
  const stored = read(readJson<unknown>(storage, key, json, undefined));
  if (stored !== undefined) store.set(() => stored);
  store.subscribe(() => writeJson(storage, key, save(store.get())));
}

type ReviewStores = Pick<PanelServices, "drafts" | "diffPrefs" | "viewed">;
const attached = new WeakMap<ReviewStores, KeyValueStorage>();

/** Load the review state from `storage` and keep it written there (once per services). */
export function persistReview(
  services: ReviewStores,
  storage: KeyValueStorage | undefined,
  subscribe: (changed: () => void) => void = (changed) => {
    if (typeof window === "undefined") return;
    window.addEventListener("storage", (event) => {
      if (
        event.storageArea === storage &&
        (event.key === null || event.key.startsWith("ace.review."))
      )
        changed();
    });
  },
) {
  if (!storage || attached.get(services) === storage) return;
  attached.set(services, storage);
  persistDrafts(services.drafts, storage, StoredDraft, (draft) => settleDraft(draft), subscribe);
  persist<DiffPrefs>(
    services.diffPrefs,
    storage,
    keys.prefs,
    (stored) => {
      const prefs = Prefs.safeParse(stored);
      return prefs.success ? prefs.data : undefined;
    },
    (prefs) => prefs,
  );
  persist<ViewedFiles>(services.viewed, storage, keys.viewed, readViewed, storedViewed);
}

/** Mark a file viewed at this version of its diff, or clear the mark. Newest threads last. */
export function setViewed(
  store: LocalStore<ViewedFiles>,
  threadId: string,
  path: string,
  version: string | undefined,
) {
  store.set((viewed) => withViewed(viewed, threadId, path, version));
}
