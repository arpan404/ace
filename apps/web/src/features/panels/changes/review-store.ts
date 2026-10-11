import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";
import type { DiffPrefs, PanelServices, ViewedFiles } from "../services.ts";
import type { LocalStore } from "../store.ts";
import type { ReviewDraft } from "./drafts.ts";
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

/** Threads whose viewed marks are kept, the most recently changed first, and files per thread. */
const maxViewedThreads = 64;
const maxViewedFiles = 500;

const Draft = z.object({
  key: z.string(),
  threadId: z.string(),
  file: z.string(),
  side: z.enum(["old", "new"]),
  line: z.number(),
  end: z.optional(z.number()),
  text: z.string(),
  suggestion: z.optional(z.string()),
  applied: z.optional(z.boolean()),
  state: z.enum(["draft", "sending", "sent", "failed", "resolving", "resolved"]),
  error: z.optional(z.string()),
  commentId: z.optional(z.string()),
  sessionId: z.optional(z.string()),
  anchor: z.optional(z.enum(["active", "outdated", "addressed-pending-review"])),
  createdAt: z.number(),
});

const Prefs = z.object({
  mode: z.catch(z.enum(["auto", "unified", "split"]), "auto"),
  wrap: z.catch(z.boolean(), false),
  tree: z.catch(z.boolean(), true),
});

const Viewed = z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.string()]))]));

/**
 * A send or resolve that was in flight when the page went away never confirmed: a send is
 * offered again (its recorded comment ids make the retry safe), a resolve goes back to sent.
 */
function settle(draft: ReviewDraft): ReviewDraft {
  if (draft.state === "sending")
    return { ...draft, state: "failed", error: "the page closed before ace confirmed" };
  if (draft.state === "resolving") return { ...draft, state: "sent" };
  return draft;
}

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
  persistDrafts(services.drafts, storage, Draft, settle, subscribe);
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
  persist<ViewedFiles>(
    services.viewed,
    storage,
    keys.viewed,
    (stored) => {
      const viewed = Viewed.safeParse(stored);
      return viewed.success
        ? new Map(viewed.data.map(([thread, files]) => [thread, new Map(files)]))
        : undefined;
    },
    (viewed) =>
      [...viewed]
        .slice(-maxViewedThreads)
        .map(([thread, files]) => [thread, [...files].slice(-maxViewedFiles)]),
  );
}

/** Mark a file viewed at this version of its diff, or clear the mark. Newest threads last. */
export function setViewed(
  store: LocalStore<ViewedFiles>,
  threadId: string,
  path: string,
  version: string | undefined,
) {
  store.set((viewed) => {
    const next = new Map(viewed);
    const files = new Map(next.get(threadId));
    files.delete(path);
    if (version !== undefined) files.set(path, version);
    next.delete(threadId);
    if (files.size) next.set(threadId, files);
    return next;
  });
}
