import type { ProcessListing } from "./process-listing.ts";
import { killGroup, killGroupWhile, signalOwnedMembers } from "./process-owner.ts";
import { supervisorBackend } from "./native-switches.ts";
import { systemTreeIo, type TreeIo, type TreeMember } from "./process-tree.ts";
import type { StartOrder } from "./start-order.ts";

/** One signal for a leader's group, with what proves which processes are the group's. */
export type GroupSignal = {
  /** The leader as recorded at spawn: its group may go by number only while its pid shows this. */
  leader: TreeMember;
  /** Whether the leader's own exit was still unheard when the signal was asked for. */
  unreaped: boolean;
  /** Members recorded while the leader lived, or linked to it by recorded lineage. */
  members: TreeMember[];
  signal: NodeJS.Signals;
};

/** `order` places kernel start times against "now"; without one, no start counts as earlier. */
export type GroupIo = { tree: TreeIo; listing: ProcessListing; order?: StartOrder };

/** The start a pid shows now, a zombie's included: what a leader's pin is checked against. */
export function startOf(pid: number, listing: ProcessListing): string | undefined {
  try {
    return listing.info(pid)?.start;
  } catch {
    return undefined;
  }
}

/**
 * Deliver a group signal under this isolate's rules: by number while the leader's pid still
 * shows its recorded start (checked again immediately before kill(-pid)), else to the members
 * one by one, each checked against its own start.
 */
export function deliverGroupSignal(request: GroupSignal, io: GroupIo): void {
  const { leader } = request;
  // Under the native supervisor the signal goes only through a handle that holds the leader, so
  // the number cannot be handed to another group between a check and kill(-pid): by the start
  // read at spawn, and never by pid alone (E2a). The TypeScript rules below are the switch-off
  // path; an injected table keeps them too, since the supervisor's own tables are the system's.
  if (supervisorBackend() === "native" && io.tree === systemTreeIo) {
    killGroup(
      leader.pid,
      request.signal,
      undefined,
      leader.start === "" ? undefined : leader.start,
    );
    return;
  }
  const pinned = () => request.unreaped && startOf(leader.pid, io.listing) === leader.start;
  if (pinned() && killGroupWhile(leader.pid, request.signal, pinned) !== "unpinned") return;
  signalOwnedMembers(request.members, request.signal, io.tree);
}
