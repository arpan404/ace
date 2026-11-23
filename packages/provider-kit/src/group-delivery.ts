import type { ProcessListing } from "./process-listing.ts";
import { killGroupWhile, signalOwnedMembers } from "./process-owner.ts";
import type { TreeIo, TreeMember } from "./process-tree.ts";

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

export type GroupIo = { tree: TreeIo; listing: ProcessListing };

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
  const pinned = () => request.unreaped && startOf(leader.pid, io.listing) === leader.start;
  if (pinned() && killGroupWhile(leader.pid, request.signal, pinned) !== "unpinned") return;
  signalOwnedMembers(request.members, request.signal, io.tree);
}
