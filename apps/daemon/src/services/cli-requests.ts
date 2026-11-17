import {
  type ThreadId,
  type CliOpenRequest,
  type CliRequestList,
  type Interaction,
  type Thread,
} from "@ace/protocol";
import type { ServiceContext } from "./types.ts";

/** At most this many threads are read for one list: a bounded read, never the whole history. */
const threadBound = 500;
const defaultLimit = 100;

export interface RequestListInput {
  readonly threadId?: ThreadId | undefined;
  readonly limit?: number | undefined;
  /** Whether the caller may read this thread; threads it can't read are left out. */
  readonly canRead: (threadId: ThreadId) => boolean;
}

/** What `open requests` needs from the daemon: threads, their open asks, interactions. */
export interface RequestSource {
  /** Threads waiting on a person, newest activity first, at most `limit`. */
  needsYouThreads(limit: number): readonly ThreadId[];
  thread(id: ThreadId): Thread | undefined;
  interaction(id: string): Interaction | undefined;
  /** The thread's unsettled delegated descendants. */
  descendants(id: ThreadId): readonly ThreadId[];
}

/**
 * Every open request across the threads the caller can read, oldest first (ADR 0176 §7,
 * `ace request list`). Pure over `source`: reads only the threads that wait on a person, and
 * each one's own list of open asks (`live.asking`), so the work is bounded by what is open.
 */
export function openRequests(source: RequestSource, input: RequestListInput): CliRequestList {
  const limit = input.limit ?? defaultLimit;
  const threads = input.threadId
    ? [input.threadId, ...source.descendants(input.threadId)]
    : source.needsYouThreads(threadBound);
  const seen = new Set<string>();
  const found: CliOpenRequest[] = [];
  for (const id of threads) {
    if (!input.canRead(id)) continue;
    const thread = source.thread(id);
    if (!thread) continue;
    for (const ask of thread.live?.asking ?? []) {
      if (seen.has(ask.id)) continue;
      seen.add(ask.id);
      const interaction = source.interaction(ask.id);
      if (interaction?.state !== "pending") continue;
      found.push({
        threadId: thread.id,
        threadTitle: thread.title.slice(0, 256),
        workspaceId: thread.workspaceId,
        provider: thread.provider,
        // The provider's own frames stay in the thread; the list carries what a person answers.
        interaction: { ...interaction, raw: [] },
      });
    }
  }
  found.sort(
    (a, b) =>
      a.interaction.createdAt - b.interaction.createdAt ||
      (a.interaction.id < b.interaction.id ? -1 : 1),
  );
  return { requests: found.slice(0, limit), truncated: found.length > limit };
}

/** The daemon's store and delegation journal as a `RequestSource`. */
export function storeRequestSource(context: Pick<ServiceContext, "store" | "services">) {
  const { store, services } = context;
  const journal = services.agentControl?.delegations.journal;
  return {
    // An in-memory set the event writer keeps current: no read of the threads table per call.
    needsYouThreads: (limit: number) => store.needsYou.list(limit),
    thread: (id: ThreadId) => store.getThread(id),
    interaction: (id: string) => store.getInteraction(id),
    descendants: (id: ThreadId) => journal?.liveDescendants(id).map((edge) => edge.childId) ?? [],
  } satisfies RequestSource;
}
