import type { ProviderAdapter } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { MemberWork, RemoteStart } from "./member-work.ts";

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
  /**
   * Before a provider process starts for `thread`, or a session resumes: the owner's lease is
   * taken or renewed, and the environment that contains the tree's processes is answered.
   */
  spawn(thread: ThreadId): Record<string, string> | undefined;
  /** Before anything reaches the provider that makes it run work: input, answers, goals. */
  work(thread: ThreadId): void;
  /** Before `thread` delegates to another host: the start, recorded until its answer comes. */
  delegate(thread: ThreadId): RemoteStart | undefined;
}

/**
 * The gate over `ownerOf` and the host's member work. An owned thread with no member work to
 * vouch for its owner (not wired yet, or no organization) is refused: it fails closed. No call
 * through it clears a stop: only the owner's proven input does, through `MemberWork.resume`.
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
  const admitted = (thread: ThreadId) => {
    const found = owned(thread);
    if (found && !found.work.admit(found.owner.account, found.owner.root)) throw new OwnerRefused();
    return found;
  };
  return {
    spawn(thread) {
      const found = admitted(thread);
      return found?.work.launchEnv(found.owner.account, found.owner.root);
    },
    work(thread) {
      admitted(thread);
    },
    delegate(thread) {
      const found = owned(thread);
      if (!found) return undefined;
      const start = found.work.remoteStart(found.owner.account, found.owner.root);
      if (!start) throw new OwnerRefused();
      return start;
    },
  };
}

/**
 * `adapter` behind the gate: a session opens only for a thread whose owner may run work, taking
 * their lease, with the tree's containment in its environment; and every call that makes the
 * provider run work (input, answers to its requests, goals) is checked again right before it is
 * made. Stopping calls (interrupt, task stop, close) always pass. `gate` is read at each call:
 * the host's member work starts after the engine.
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
      const check = () => gate()?.work(session.threadId);
      const send = opened.send.bind(opened);
      opened.send = (input, delivery, commandId, origin, fence) => {
        check();
        return send(input, delivery, commandId, origin, fence);
      };
      const resolve = opened.resolve.bind(opened);
      opened.resolve = (interaction, resolution) => {
        check();
        return resolve(interaction, resolution);
      };
      const setGoal = opened.setGoal?.bind(opened);
      if (setGoal)
        opened.setGoal = (change) => {
          check();
          return setGoal(change);
        };
      return opened;
    },
  };
}
