import { externalAgentStatus } from "@ace/core";
import type { Agent, ThreadStatus } from "@ace/protocol";
import type { ThreadWork } from "@ace/ui-core";

/*
 * A delegate's row reads the status its parent last recorded for it, which goes stale when the
 * delegate's thread isn't loaded (the tree holds a bounded number) or the update was missed. The
 * thread list carries every thread's live status, so it overrules the recorded one: an active
 * delegate ranks and shows as active whatever its parent says, and a settled one flips at once.
 * Pure.
 */

const same = (left: Agent["status"], right: Agent["status"]) =>
  left.state === right.state &&
  (left.state !== "blocked" || (right.state === "blocked" && left.on === right.on));

/** `work` with each delegate's status read from its thread's list entry; `work` itself when none differ. */
export function withLiveStatus(
  work: ThreadWork,
  statusOf: (threadId: string) => ThreadStatus | undefined,
): ThreadWork {
  let changed = false;
  const agents = work.agents.map((agent) => {
    const child = agent.machine ? undefined : agent.childThreadId;
    const live = child ? statusOf(child) : undefined;
    if (!child || !live) return agent;
    const status = externalAgentStatus(live, child);
    if (same(agent.status, status)) return agent;
    changed = true;
    return { ...agent, status };
  });
  return changed ? { ...work, agents } : work;
}
