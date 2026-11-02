import type { ThreadListEntry, ThreadPlace } from "@ace/protocol";
import {
  noAttention,
  threadSignal,
  withSignal,
  type PlaceAttention,
  type PlaceAttentions,
} from "./thread-place.ts";
import type { Standing } from "./thread-standing.ts";

/*
 * The rail's dots for Threads and Chats (DESIGN.md §3, Rail), each from what that place lists.
 * The daemon sends its own totals with the thread list (`ThreadListWindow.attention`); a client
 * adds those of every machine, and works them out itself with the same rule only for a list
 * that came without them (an older daemon, another machine's entries).
 */

/** What a rail place's dot says: something waits on the person, or news not yet seen. */
export type PlaceTone = "needs-you" | "unread";

export interface PlaceSignal {
  tone: PlaceTone | undefined;
  /** How many of the place's threads need the person. */
  needsYou: number;
}

export interface PlaceSignals {
  threads: PlaceSignal;
  chats: PlaceSignal;
}

export interface PlaceAttentionInput {
  entries: Iterable<ThreadListEntry>;
  /** Whether an entry is a chat (`isChatEntry`, or the project list's word). */
  isChat(entry: ThreadListEntry): boolean;
  /** Its place in the panel: the daemon's, or the shared rule's (`placeReader`). */
  place(entry: ThreadListEntry): ThreadPlace | undefined;
  standing(entry: ThreadListEntry): Standing;
}

/** Each place's totals from the threads it lists (`threadSignal`). */
export function placeAttention(input: PlaceAttentionInput): PlaceAttentions {
  let totals = noAttention;
  for (const entry of input.entries) {
    const place = input.place(entry);
    if (place?.tab !== "inbox") continue;
    totals = withSignal(totals, threadSignal(place, input.standing(entry), input.isChat(entry)), 1);
  }
  return totals;
}

function signalOf(attention: PlaceAttention): PlaceSignal {
  return {
    tone: attention.needsYou > 0 ? "needs-you" : attention.unread > 0 ? "unread" : undefined,
    needsYou: attention.needsYou,
  };
}

/** The dots the totals draw: a request asks loudest, then news not yet seen. */
export function placeSignals(attention: PlaceAttentions): PlaceSignals {
  return { threads: signalOf(attention.threads), chats: signalOf(attention.chats) };
}
