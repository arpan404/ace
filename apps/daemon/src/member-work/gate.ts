import type { ProviderAdapter } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { MemberWork } from "./member-work.ts";

/*
 * The member gate (ADR 0209 §4.2, §7): on an org host, no work of a member's tree starts unless
 * its owner may run work here now. It is applied before a provider process is spawned (pooled
 * ones too: each thread's session opens through it), before any input reaches a provider (turn
 * dispatch, queued starts, automation and wake runs, steers) and before work is delegated to
 * another host. Background shells are the provider's own children: they run inside the session
 * and its containment, which a stop kills.
 *
 * Who owns a thread is `OwnerOf`'s answer, filled in from `thread_access` by the access policy
 * (ADR 0209 §5.3). It answers none on a personal machine and for the host's own threads, which
 * the gate lets through unchanged.
 */

/** A thread's owner on an org host, and the root of the tree whose lease they hold. */
export type ThreadOwner = { account: string; root: ThreadId };
export type OwnerOf = (thread: ThreadId) => ThreadOwner | undefined;
/** No thread has a member owner: a personal machine, or an org host before owners are kept. */
export const noOwners: OwnerOf = () => undefined;

/** The thread's owner may no longer run work on this host. */
export class OwnerRefused extends Error {
  readonly code = "owner_not_active";
  constructor() {
    super("This thread's owner can't run work on this host right now.");
  }
}

export interface OwnerGate {
  /** Before a provider process starts for `thread`: the environment that contains it. */
  spawn(thread: ThreadId): Record<string, string> | undefined;
  /** Before input reaches the provider: the person's own (`person`), or anything else. */
  dispatch(thread: ThreadId, origin: "person" | "other"): void;
  /** Before `thread` delegates work to another host. */
  delegate(thread: ThreadId): void;
}

/**
 * The gate over `ownerOf` and the host's member work. An owned thread with no member work to
 * vouch for its owner (not wired yet, or no organization) is refused: it fails closed.
 */
export function ownerGate(deps: {
  ownerOf: OwnerOf;
  work: () => MemberWork | undefined;
}): OwnerGate {
  const owned = (thread: ThreadId) => {
    const owner = deps.ownerOf(thread);
    if (!owner) return undefined;
    const work = deps.work();
    if (!work) throw new OwnerRefused();
    return { owner, work };
  };
  return {
    spawn(thread) {
      const found = owned(thread);
      if (!found) return undefined;
      const { owner, work } = found;
      if (!work.active(owner.account) || work.pendingStops().includes(owner.root))
        throw new OwnerRefused();
      return work.launchEnv(owner.account);
    },
    dispatch(thread, origin) {
      const found = owned(thread);
      if (found && !found.work.admit(found.owner.account, found.owner.root, origin))
        throw new OwnerRefused();
    },
    delegate(thread) {
      const found = owned(thread);
      if (found && !found.work.admit(found.owner.account, found.owner.root, "other"))
        throw new OwnerRefused();
    },
  };
}

/**
 * `adapter` behind the gate: a session opens only for a thread whose owner may run work, with
 * the owner's containment in its environment, and each input is checked again right before it
 * is sent. `gate` is read at each call: the host's member work starts after the engine.
 */
export function withOwnerGate(
  gate: () => OwnerGate | undefined,
  adapter: ProviderAdapter,
): ProviderAdapter {
  return {
    ...adapter,
    async openSession(session) {
      const contained = gate()?.spawn(session.threadId);
      const opened = await adapter.openSession(
        contained ? { ...session, env: { ...session.env, ...contained } } : session,
      );
      const send = opened.send.bind(opened);
      opened.send = (input, delivery, commandId, origin, fence) => {
        gate()?.dispatch(session.threadId, origin === undefined ? "person" : "other");
        return send(input, delivery, commandId, origin, fence);
      };
      return opened;
    },
  };
}
