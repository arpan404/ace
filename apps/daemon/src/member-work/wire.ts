import { ThreadId } from "@ace/protocol";
import { AceOrgRoster } from "@ace/protocol/ace-org";
import type { GrantKeySet } from "@ace/account-grant";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Engine } from "../engine/index.ts";
import type { Services } from "../services/types.ts";
import { memberContainment, type Containment } from "./containment.ts";
import { BackendUnreachable, memberWork, type MemberWork, type TreeStop } from "./member-work.ts";
import type { StopReason } from "./rules.ts";
import { memberWorkStore } from "./store.ts";

const requestMs = 15_000;

/** What stopping a member tree needs of the daemon. */
export type TreeStopDeps = {
  engine: Pick<Engine, "cleanupThreads" | "hasUnfinishedWork" | "stopForOwner" | "flush">;
  delegations: Pick<NonNullable<Services["agentControl"]>["delegations"], "cancelMember">;
  /** The tree's children on other hosts, and the cross-machine stop (ADR 0052, ADR 0191). */
  remote?: {
    under(root: ThreadId): ThreadId[];
    cancel(child: ThreadId): Promise<unknown>;
  };
};

/** What a member tree's stop says on it, in place of the owner's own outcome (§7.1, §11). */
export const memberStopFailures: Record<StopReason, { code: string; title: string }> = {
  revoked: {
    code: "member_revoked",
    title: "Stopped · its owner is no longer in this organization",
  },
  lease_expired: {
    code: "member_lease_expired",
    title: "Stopped · couldn't confirm its owner is still in this organization",
  },
  stopped: { code: "member_stopped", title: "Stopped by an owner of this organization" },
};

/**
 * Stops one member tree (AGENTS.md priority 1: no part of it reads done). Before anything is
 * awaited, every unfinished thread is fenced from delegation and result delivery and, through
 * `Engine.stopForOwner`, from new work, with what was unsettled recorded as failed. Its children
 * on other hosts get the cross-machine stop, which the children's ledger repeats until each
 * machine confirms. Then the local sessions close and drain.
 */
export async function stopMemberTree(
  deps: TreeStopDeps,
  root: string,
  reason: StopReason,
): Promise<TreeStop> {
  const rootId = ThreadId.parse(root);
  const tree = deps.engine.cleanupThreads(rootId);
  const unfinished = tree.filter((id) => deps.engine.hasUnfinishedWork(id));
  const remote = deps.remote?.under(rootId) ?? [];
  if (unfinished.length === 0 && remote.length === 0) return "idle";
  for (const id of unfinished) deps.delegations.cancelMember(id);
  // Fenced synchronously when called; awaited only once the remote stops are sent.
  const stopping = deps.engine.stopForOwner(tree, memberStopFailures[reason]);
  for (const child of remote) await deps.remote?.cancel(child);
  const closed = await stopping;
  await deps.engine.flush();
  return closed ? "stopped" : "unconfirmed";
}

/** How the running daemon stops a member tree: its engine, agent control and machine links. */
export function memberTreeStopper(services: {
  engine?: Services["engine"] | undefined;
  agentControl?: Services["agentControl"] | undefined;
  machines?: Services["machines"] | undefined;
}): TreeStopDeps | undefined {
  const { engine, machines } = services;
  const delegations = services.agentControl?.delegations;
  if (!engine || !delegations) return undefined;
  return {
    engine,
    delegations,
    ...(machines
      ? {
          remote: {
            under: (root: ThreadId) => machines.children.under(root),
            cancel: (child: ThreadId) => machines.caller.cancel(child),
          },
        }
      : {}),
  };
}

/** The machine account, as members' work reads it. */
export type MemberAccount = {
  ownerKnown(): boolean;
  ownerOrg(): string | undefined;
  relayHostId(): string | undefined;
  orgHostSession(): { origin: string; token: string } | undefined;
  grantKeys(): GrantKeySet;
};

/**
 * Members' work for this daemon (ADR 0209 §7). It runs on every machine with an ace sign-in and
 * does nothing until the machine is an organization's host: on a personal machine no roster is
 * asked for and no work is touched. `stopper` is read at each stop: the engine and agent
 * control start after it.
 */
export function startMemberWork(deps: {
  account: MemberAccount;
  store: { atomic<T>(run: (db: DatabaseSync) => T): T };
  stopper: () => TreeStopDeps | undefined;
  /** This daemon's home, which names its members' containment. */
  instance: string;
  fetch?: typeof fetch;
  containment?: Containment;
  log?: (error: Error) => void;
}): MemberWork {
  const { account } = deps;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const work = memberWork({
    store: memberWorkStore(deps.store),
    org: () => (account.ownerKnown() ? account.ownerOrg() : undefined),
    host: () => account.relayHostId(),
    async fetchRoster(org, host) {
      const session = account.orgHostSession();
      if (!session) throw new Error("This org host isn't signed in as its organization.");
      let response: Response;
      try {
        response = await fetcher(
          `${session.origin}/v1/orgs/${encodeURIComponent(org)}/hosts/${encodeURIComponent(host)}/roster`,
          {
            headers: { Authorization: `Bearer ${session.token}` },
            signal: AbortSignal.timeout(requestMs),
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
          },
        );
      } catch (error) {
        throw new BackendUnreachable(error instanceof Error ? error.message : String(error));
      }
      // The backend's edge failing is no answer; anything else it says is its answer.
      if (response.status >= 500)
        throw new BackendUnreachable(`The backend failed (${response.status}).`);
      if (response.status !== 200)
        throw new Error(`The organization's roster was refused (${response.status}).`);
      return AceOrgRoster.parse(await response.json());
    },
    keys: () => account.grantKeys(),
    stopTree: async (root, reason) => {
      const stopper = deps.stopper();
      if (!stopper) return "unconfirmed";
      return stopMemberTree(stopper, root, reason);
    },
    containment: deps.containment ?? memberContainment(process.platform, deps.instance),
    wall: Date.now,
    monotonic: () => performance.now(),
    delay: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(deps.log ? { log: deps.log } : {}),
  });
  void work.start();
  return work;
}
