import type { ThreadStatus } from "@ace/protocol";

/** A provider retry is live; only a stopped turn with no remaining work can settle. */
export function limitSettles(
  status: ThreadStatus,
  facts: { stopped: boolean; resuming: boolean; descendantsPending: boolean },
): boolean {
  return (
    status.state === "limited" && facts.stopped && !facts.resuming && !facts.descendantsPending
  );
}

/** Read the engine and journal at settlement, including work the status badge cannot express. */
export function childStoppedOnLimit(
  thread: import("@ace/protocol").Thread,
  engine: Pick<import("../engine/index.ts").Engine, "endedOnLimit" | "resuming"> | undefined,
  journal: Pick<import("./journal.ts").DelegationJournal, "liveDescendants"> | undefined,
): boolean {
  return (
    thread.status.state === "limited" &&
    limitSettles(thread.status, {
      stopped: engine?.endedOnLimit(thread.id) ?? false,
      resuming: engine?.resuming(thread.id) ?? false,
      descendantsPending: (journal?.liveDescendants(thread.id).length ?? 0) > 0,
    })
  );
}
