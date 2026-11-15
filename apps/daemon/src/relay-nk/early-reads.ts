import type { ClientMessage, EarlySubscribe, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { SubscriptionStore } from "../subscription.ts";
import type { NkSession } from "./admission.ts";

/*
 * The read subscribes an NK first message carries (ADR 0155, "Read subscribes before
 * confirmation"). Each is checked against the unconfirmed session's budgets before anything is
 * acquired; one that would go over waits for the confirmation. The ones that run hold their
 * threads quietly: a quiet hold doesn't make a thread viewed, so no workspace refresh, git read,
 * event or forge call follows from it until the client confirms.
 */

/** What a thread subscribe may cost before confirmation: its snapshot tail, and the rest whole. */
const SNAPSHOT_BYTES = 1024 * 1024;
const THREAD_OVERHEAD = 256 * 1024;
const WINDOW_BYTES = 256 * 1024;

export type EarlyPlan = { now: ClientMessage[]; later: ClientMessage[] };

function message(subscribe: EarlySubscribe): ClientMessage {
  return { type: "subscribe", ...subscribe };
}

/**
 * Splits a first message's subscribes into those that fit the session's budgets now and those
 * that wait. Costs are bounded from above before any read: a thread's snapshot by its tail
 * (1 MiB unless the client asked for less) plus what it holds whole, a replay by its event
 * count from the index, a sidebar window by its 20-row page.
 */
export function planEarlySubscribes(
  subscribes: EarlySubscribe[],
  session: NkSession,
  store: Pick<Store, "headSeq" | "countThreadEvents">,
): EarlyPlan {
  const plan: EarlyPlan = { now: [], later: [] };
  const head = store.headSeq();
  for (const subscribe of subscribes) {
    const fits =
      subscribe.scope.kind === "threads"
        ? session.reserveBytes(WINDOW_BYTES)
        : fitsThread(subscribe, subscribe.scope.threadId, session, store, head);
    (fits ? plan.now : plan.later).push(message(subscribe));
  }
  return plan;
}

function fitsThread(
  subscribe: EarlySubscribe,
  threadId: ThreadId,
  session: NkSession,
  store: Pick<Store, "countThreadEvents">,
  head: number,
): boolean {
  if (subscribe.afterSeq !== undefined) {
    const events = store.countThreadEvents(threadId, subscribe.afterSeq, head, 2_001);
    if (!session.reserveEvents(events)) return false;
  }
  return session.reserveBytes((subscribe.tail?.bytes ?? SNAPSHOT_BYTES) + THREAD_OVERHEAD);
}

/**
 * `store` for an unconfirmed session's subscribes: every thread it holds is hushed until
 * `confirm`, and a hush is lifted when its hold is let go. After `confirm` it is `store` as is.
 */
export function quietReads(store: Store): { store: SubscriptionStore; confirm(): void } {
  const hushed = new Map<ThreadId, number>();
  let confirmed = false;
  const reads: SubscriptionStore = {
    getThread: (id) => store.getThread(id),
    snapshotThread: (...args) => store.snapshotThread(...args),
    subscribe: (...args) => store.subscribe(...args),
    headSeq: () => store.headSeq(),
    acquireThread(id) {
      const view = store.acquireThread(id);
      if (!confirmed) {
        store.quietHolds.hush(id);
        hushed.set(id, (hushed.get(id) ?? 0) + 1);
      }
      return view;
    },
    releaseThread(id) {
      const quiet = hushed.get(id) ?? 0;
      if (quiet > 0) {
        store.quietHolds.voice(id);
        if (quiet === 1) hushed.delete(id);
        else hushed.set(id, quiet - 1);
      }
      store.releaseThread(id);
    },
    listThreads: (...args) => store.listThreads(...args),
    sidebarPage: (...args) => store.sidebarPage(...args),
    readEvents: (...args) => store.readEvents(...args),
    replaySafe: (...args) => store.replaySafe(...args),
    sidebarRowRevision: (...args) => store.sidebarRowRevision(...args),
    sidebarToken: () => store.sidebarToken(),
    countThreadEvents: (...args) => store.countThreadEvents(...args),
    threadReadState: (...args) => store.threadReadState(...args),
    onThreadRead: (...args) => store.onThreadRead(...args),
  };
  return {
    store: reads,
    confirm() {
      confirmed = true;
      for (const [id, count] of hushed) for (let n = 0; n < count; n++) store.quietHolds.voice(id);
      hushed.clear();
    },
  };
}
