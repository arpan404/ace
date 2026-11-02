import { z } from "zod";

/*
 * Where the daemon puts a listed thread in the Threads panel (ADR 0107): which tab, which band
 * of the Inbox, and the keys that order it. The daemon decides; clients show it as given, and
 * merge several machines' lists by the same keys.
 */

/** The Threads panel's three places. */
export const ThreadTab = z.enum(["inbox", "snoozed", "settled"]);
export type ThreadTab = z.infer<typeof ThreadTab>;

/**
 * The Inbox's bands, top to bottom: pinned; needs you (a request, an unseen failure); running
 * (the whole agent tree counted); finished but unseen; idle. `listed` holds every unpinned
 * thread when the person sorts by creation or by hand instead of by live activity.
 */
export const InboxBand = z.enum(["pinned", "needs-you", "running", "unseen", "idle", "listed"]);
export type InboxBand = z.infer<typeof InboxBand>;

export const ThreadPlace = z.object({
  tab: ThreadTab,
  /** The Inbox band; absent in Snoozed and Settled. */
  band: InboxBand.optional(),
  /** Order within the tab and band: compared key by key, higher first, then by thread id. */
  rank: z.array(z.number()).min(1).max(4),
});
export type ThreadPlace = z.infer<typeof ThreadPlace>;

/**
 * Lets a reconnecting list skip what it already holds (`SubscriptionScope` `threads.window`).
 * `revision` is the newest thread row revision the list saw; `epoch` names the database and the
 * placement settings it was read under, so a list from another database or sort starts over.
 */
export const ThreadListResume = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  epoch: z.string().min(1).max(256),
});
export type ThreadListResume = z.infer<typeof ThreadListResume>;

/** A place as a list entry carries it: one a newer daemon words differently is dropped, not fatal. */
export const ListedThreadPlace = z
  .unknown()
  .transform((value): ThreadPlace | undefined => ThreadPlace.safeParse(value).data)
  .meta({
    "x-ace-json-input": ThreadPlace,
    "x-ace-constraint": "A place that does not parse is accepted and decoded as absent.",
  });

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** One rail place's dot: how many threads it lists live that need the person or hold news. */
export const PlaceAttention = z.object({ needsYou: count, unread: count });
export type PlaceAttention = z.infer<typeof PlaceAttention>;
/**
 * The rail's Threads and Chats dots, from what each place lists (DESIGN.md §3, Rail): every
 * client shows the daemon's, adding each machine's.
 */
export const ListAttention = z.object({ threads: PlaceAttention, chats: PlaceAttention });
export type ListAttention = z.infer<typeof ListAttention>;
