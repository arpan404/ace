import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import type { SceneSignal } from "@ace/protocol/suits";

/**
 * Which scene signals a change in the thread list makes. Only news counts: a thread already
 * known in another state that moves into working, needs-you, done or failed, and a linked pull
 * request already known unmerged that is now merged. The first snapshot, and threads or PRs that
 * arrive in their state, are history. Each signal goes once per change however many threads
 * made it. Nothing about which thread it was leaves this module. Pure.
 */

export interface SignalSnapshot {
  /** Thread id → status. */
  readonly states: ReadonlyMap<string, ThreadStatus["state"]>;
  /** Linked pull request (by URL) → whether it is merged. */
  readonly prs: ReadonlyMap<string, boolean>;
}

const signalFor: Partial<Record<ThreadStatus["state"], SceneSignal>> = {
  working: "working",
  needs_you: "waiting",
  done: "done",
  failed: "failed",
};

/** The thread list as signals see it; `include` drops threads that aren't this person's news. */
export function signalSnapshot(
  threads: Iterable<ThreadListEntry>,
  include: (thread: ThreadListEntry) => boolean = () => true,
): SignalSnapshot {
  const states = new Map<string, ThreadStatus["state"]>();
  const prs = new Map<string, boolean>();
  for (const thread of threads) {
    if (!include(thread)) continue;
    states.set(thread.id, thread.status.state);
    for (const pr of thread.details?.linkedPrs ?? []) prs.set(pr.url, pr.state === "merged");
    const legacy = thread.details?.linkedPr;
    if (legacy?.url && !prs.has(legacy.url)) prs.set(legacy.url, legacy.state === "merged");
  }
  return { states, prs };
}

export function sceneSignals(previous: SignalSnapshot, next: SignalSnapshot): SceneSignal[] {
  const signals = new Set<SceneSignal>();
  for (const [id, state] of next.states) {
    const before = previous.states.get(id);
    if (before === undefined || before === state) continue;
    const signal = signalFor[state];
    if (signal) signals.add(signal);
  }
  for (const [url, merged] of next.prs)
    if (merged && previous.prs.get(url) === false) signals.add("pr-merged");
  return [...signals];
}
