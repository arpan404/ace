import { ThreadId } from "@ace/protocol";
import { AceOrgRoster } from "@ace/protocol/ace-org";
import type { ServerOptions } from "../server-options.ts";
import { memberContainment, type Containment } from "./containment.ts";
import { memberWork, type MemberWork } from "./member-work.ts";
import type { StopReason } from "./rules.ts";
import { memberWorkStore } from "./store.ts";

const requestMs = 15_000;

/** What stopping a member tree needs of the daemon. */
export type TreeStopDeps = {
  engine: Pick<
    NonNullable<ServerOptions["engine"]>,
    "cleanupThreads" | "hasUnfinishedWork" | "cleanupSession" | "stopForOwner" | "flush"
  >;
  delegations: Pick<NonNullable<ServerOptions["agentControl"]>["delegations"], "cancelMember">;
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
 * Stops one member tree: every unfinished part fenced from delegation, its session closed and
 * what was unsettled recorded as failed with why, so no part of it reads done (AGENTS.md
 * priority 1). Settled parts only lose their retained session. False when nothing in it was
 * running.
 */
export async function stopMemberTree(
  deps: TreeStopDeps,
  root: string,
  reason: StopReason,
): Promise<boolean> {
  const tree = deps.engine.cleanupThreads(ThreadId.parse(root));
  const unfinished = tree.filter((id) => deps.engine.hasUnfinishedWork(id));
  if (unfinished.length === 0) return false;
  // Every part fenced before any stops, so a stopping child can't hand its result upward.
  for (const id of unfinished) deps.delegations.cancelMember(id);
  for (const id of tree)
    if (unfinished.includes(id)) await deps.engine.stopForOwner(id, memberStopFailures[reason]);
    else await deps.engine.cleanupSession(id);
  await deps.engine.flush();
  return true;
}

/**
 * Members' work for this daemon (ADR 0209 §7). It runs on every machine with an ace sign-in and
 * does nothing until the machine is an organization's host: on a personal machine no roster is
 * asked for and no work is touched.
 */
export function startMemberWork(
  options: ServerOptions,
  containment: Containment = memberContainment(
    process.platform,
    options.remoteConfig?.dataDir ?? "ace",
  ),
): MemberWork | undefined {
  const account = options.machineAccount;
  if (!account) return undefined;
  const fetcher = options.orgHostFetch ?? globalThis.fetch;
  const work = memberWork({
    store: memberWorkStore(options.store),
    org: () => (account.ownerKnown() ? account.ownerOrg() : undefined),
    host: () => account.relayHostId(),
    async fetchRoster(org, host) {
      const session = account.orgHostSession();
      if (!session) throw new Error("This org host isn't signed in as its organization.");
      const response = await fetcher(
        `${session.origin}/v1/orgs/${encodeURIComponent(org)}/hosts/${encodeURIComponent(host)}/roster`,
        {
          headers: { Authorization: `Bearer ${session.token}` },
          signal: AbortSignal.timeout(requestMs),
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
        },
      );
      if (response.status !== 200)
        throw new Error(`The organization's roster didn't come (${response.status}).`);
      return AceOrgRoster.parse(await response.json());
    },
    keys: () => account.grantKeys(),
    stopTree: async (root, reason) => {
      const engine = options.engine;
      const delegations = options.agentControl?.delegations;
      if (!engine || !delegations) return false;
      return stopMemberTree({ engine, delegations }, root, reason);
    },
    containment,
    now: Date.now,
    delay: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(options.log ? { log: options.log } : {}),
  });
  void work.start();
  return work;
}
