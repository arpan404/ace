import { ReviewFingerprint, ReviewSource } from "@ace/protocol";
import * as z from "zod/mini";
import type { ReviewDraft } from "./review-drafts.ts";

/*
 * Review state a device keeps between launches: drafts as stored (parsed back, never trusted),
 * the settling of work that was in flight when the app or page went away, and viewed marks
 * bounded per thread. Pure.
 */

/** A stored draft, as `ReviewDraft`. Anything that doesn't parse is dropped. */
export const StoredDraft = z.object({
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
  fingerprint: z.optional(ReviewFingerprint),
  source: z.optional(ReviewSource),
  createdAt: z.number(),
});

/**
 * A send or resolve that was in flight when the app went away never confirmed: a send is offered
 * again (its recorded comment ids make the retry safe), a resolve goes back to sent.
 */
export function settleDraft(draft: ReviewDraft, why = "the page closed before ace confirmed") {
  if (draft.state === "sending") return { ...draft, state: "failed" as const, error: why };
  if (draft.state === "resolving") return { ...draft, state: "sent" as const };
  return draft;
}

/** Per thread, each file's diff version when it was marked viewed. */
export type ViewedFiles = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Threads whose viewed marks are kept, the most recently changed last, and files per thread. */
export const maxViewedThreads = 64;
export const maxViewedFiles = 500;

export const StoredViewed = z.array(
  z.tuple([z.string(), z.array(z.tuple([z.string(), z.string()]))]),
);

/**
 * Mark a file viewed at this version of its diff, or clear the mark (`version` undefined). The
 * thread moves to the end, so the oldest threads are the ones `storedViewed` drops.
 */
export function withViewed(
  viewed: ViewedFiles,
  threadId: string,
  path: string,
  version: string | undefined,
): ViewedFiles {
  const next = new Map(viewed);
  const files = new Map(next.get(threadId));
  files.delete(path);
  if (version !== undefined) files.set(path, version);
  next.delete(threadId);
  if (files.size) next.set(threadId, files);
  return next;
}

/** The marks as stored: the newest threads, each with its newest files. */
export const storedViewed = (viewed: ViewedFiles): z.infer<typeof StoredViewed> =>
  [...viewed]
    .slice(-maxViewedThreads)
    .map(([thread, files]) => [thread, [...files].slice(-maxViewedFiles)]);

export function readViewed(stored: unknown): ViewedFiles | undefined {
  const parsed = StoredViewed.safeParse(stored);
  return parsed.success
    ? new Map(parsed.data.map(([thread, files]) => [thread, new Map(files)]))
    : undefined;
}
