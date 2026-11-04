import type { Thread } from "@ace/protocol";

type Engine = import("../engine/index.ts").Engine;
type DelegationJournal = import("./journal.ts").DelegationJournal;

/**
 * A child stopped on its usage limit settles as failed only when nothing will carry it on: its
 * turn ended with nothing running, retrying or waiting on a person, no resume is in flight, ace
 * has no resume or account move scheduled for it (and its limit policy isn't still loading), and
 * none of its descendants is live. A held child ace resumes by itself stays open instead.
 */
export function childStoppedOnLimit(
  thread: Thread,
  engine: Pick<Engine, "endedOnLimit" | "resuming" | "limitContinues"> | undefined,
  journal: Pick<DelegationJournal, "liveDescendants"> | undefined,
): boolean {
  return (
    thread.status.state === "limited" &&
    engine !== undefined &&
    engine.endedOnLimit(thread.id) &&
    !engine.resuming(thread.id) &&
    !engine.limitContinues(thread.id) &&
    (journal?.liveDescendants(thread.id).length ?? 0) === 0
  );
}
