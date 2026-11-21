/*
 * Which machine owns a thread (ADR 0191, "Ownership record"). Pure transitions: exactly one
 * machine owns a thread at every step. No record means this machine owns its own thread.
 */

export type OwnershipState = "stopping" | "handing" | "moved" | "owned";

export interface Peer {
  hostId: string;
  name: string;
  /** The thread there: the new one for a source, the one it came from for a target. */
  threadId?: string | undefined;
}

export interface Ownership {
  threadId: string;
  state: OwnershipState;
  transferId: string;
  peer: Peer;
  /** Grows with every handover of the thread. */
  epoch: number;
  /** Held before this handover began: a thread that came here owns it again if it stays. */
  prior?: { peer: Peer; epoch: number; transferId: string } | undefined;
  at: number;
}

export type OwnershipChange =
  /** Source: finding a safe point. New turns are refused; it may still run here again. */
  | { to: "stopping"; transferId: string; peer: Peer; at: number }
  /** Source: the commit may reach the target from now on. */
  | { to: "handing"; transferId: string; at: number }
  /** Source: the target answered that it owns the thread. */
  | { to: "moved"; transferId: string; peerThread: string; at: number }
  /**
   * Source: the thread runs here again. From `handing` only with the target's own answer that
   * it never took the thread (`confirmed`), or the person's own choice, warned that both may
   * run (`byPerson`), once the target can't be asked; a lost link never returns it.
   */
  | { to: "local"; transferId: string; confirmed: boolean; byPerson?: true; at: number }
  /** Target: the thread was made here past the cutoff; this machine owns it. */
  | { to: "owned"; transferId: string; peer: Peer; epoch: number; at: number };

export class OwnershipConflict extends Error {}

export function nextOwnership(
  current: Ownership | undefined,
  threadId: string,
  change: OwnershipChange,
): Ownership | undefined {
  const same = current?.transferId === change.transferId;
  const refuse = (why: string): never => {
    throw new OwnershipConflict(`${why} (${current?.state ?? "local"} → ${change.to})`);
  };
  switch (change.to) {
    case "stopping": {
      if (current && same && current.state === "stopping") return current;
      if (current && current.state !== "owned") refuse("Another handover holds this thread");
      return {
        threadId,
        state: "stopping",
        transferId: change.transferId,
        peer: change.peer,
        epoch: (current?.epoch ?? 0) + 1,
        ...(current
          ? { prior: { peer: current.peer, epoch: current.epoch, transferId: current.transferId } }
          : {}),
        at: change.at,
      };
    }
    case "handing":
      if (!current || !same || (current.state !== "stopping" && current.state !== "handing"))
        return refuse("Only a stopped thread is handed over");
      return { ...current, state: "handing", at: change.at };
    case "moved":
      if (!current || !same || (current.state !== "handing" && current.state !== "moved"))
        return refuse("Only a handed-over thread moves");
      return {
        ...current,
        state: "moved",
        peer: { ...current.peer, threadId: change.peerThread },
        at: change.at,
      };
    case "local": {
      if (!current || !same) return refuse("This handover doesn't hold the thread");
      if (current.state === "moved") return refuse("The other machine owns this thread");
      if (current.state === "handing" && !change.confirmed && !change.byPerson)
        return refuse("Only the other machine's answer returns a handed-over thread");
      if (current.state !== "stopping" && current.state !== "handing")
        return refuse("Nothing to return");
      const prior = current.prior;
      return prior
        ? {
            threadId,
            state: "owned",
            transferId: prior.transferId,
            peer: prior.peer,
            epoch: prior.epoch,
            at: change.at,
          }
        : undefined;
    }
    case "owned":
      if (current && same && current.state === "owned") return current;
      if (current) return refuse("This thread already has an owner record");
      return {
        threadId,
        state: "owned",
        transferId: change.transferId,
        peer: change.peer,
        epoch: change.epoch,
        at: change.at,
      };
  }
}

/** Why the thread takes no new turn here, in words a person reads; none while it may. */
export function ownershipRefusal(
  record: Ownership | undefined,
): { code: string; detail: string } | undefined {
  if (!record) return undefined;
  const name = record.peer.name;
  if (record.state === "stopping" || record.state === "handing")
    return {
      code: "thread_moving",
      detail: `This thread is moving to ${name}. It takes new messages once that's done.`,
    };
  if (record.state === "moved")
    return { code: "thread_moved", detail: `This thread moved to ${name}. Continue it there.` };
  return undefined;
}
