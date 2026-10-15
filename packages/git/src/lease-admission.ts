import { realpath, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { MutationLease } from "@ace/provider-kit/cleanup";
import { clearLeftoverLocks, lockGraceMs } from "./git-locks.ts";
import { touches, type GitProcess, type GitProcessScan } from "./git-processes.ts";
import {
  ownedByThisProcess,
  queryLeaseOwner,
  scheduleProbe,
  type Schedule,
} from "./lease-owner.ts";
import {
  missing,
  orphans,
  owned,
  records,
  syncDirectory,
  text,
  type JournalEntry,
  type OwnedLease,
} from "./lease-journal.ts";
import { journalRepository, rootKind } from "./lease-roots.ts";
import {
  clearsOnItsOwn,
  fences,
  leaseState,
  quarantineMessage,
  retiresAutomatically,
  retiresOnConfirmation,
  type LeaseFacts,
  type LeaseOwnerState,
  type MutationState,
} from "./mutation-state.ts";
import { GitError, type RetiredLease } from "./types.ts";

export interface LeaseProbe {
  schedule: Schedule;
  retired?: ((event: RetiredLease) => void) | undefined;
  /**
   * Evidence that a lease's work has ended. Absent when a cleanup supervisor owns that proof:
   * then only its receipts, a stopped owner or a person retire a lease.
   */
  evidence?:
    | {
        processes: GitProcessScan;
        groupAlive: (pid: number) => boolean;
        now: () => Date | Promise<Date>;
      }
    | undefined;
  /** How long admission waits for leases that clear on their own before refusing. */
  waitMs?: number | undefined;
}
export const defaultProbe: LeaseProbe = { schedule: scheduleProbe };

const pollMs = 250;

interface Assessed extends LeaseFacts {
  file: string;
}
type Scan = () => Promise<readonly GitProcess[] | undefined>;

function memo(probe: LeaseProbe): Scan {
  let listing: Promise<readonly GitProcess[] | undefined> | undefined;
  return () => (listing ??= probe.evidence?.processes() ?? Promise.resolve(undefined));
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** Who may still be doing this lease's work, from evidence this process can trust. */
async function busy(
  owner: LeaseOwnerState,
  local: OwnedLease | undefined,
  record: MutationLease,
  probe: LeaseProbe,
  scan: Scan,
): Promise<readonly string[] | undefined> {
  const evidence = probe.evidence;
  if (!evidence) return;
  if (owner === "held" && local) {
    if (!local.groups) return;
    if (!local.done) return ["the ace operation that started it"];
    return local.groups
      .filter((pid) => evidence.groupAlive(pid))
      .map((pid) => `a stopped Git process (process group ${pid})`);
  }
  if (owner !== "gone" && owner !== "orphaned") return;
  const listing = await scan();
  if (!listing) return;
  const roots = await Promise.all(record.roots.map(canonical));
  return listing
    .filter((entry) => touches(entry, roots))
    .map(
      (entry) => `a running Git process (pid ${entry.pid}${entry.cwd ? ` in ${entry.cwd}` : ""})`,
    );
}

async function assess(
  { record, file }: JournalEntry,
  probe: LeaseProbe,
  scan: Scan,
): Promise<Assessed> {
  const local = owned(record.id);
  const owner: LeaseOwnerState = local
    ? local.quarantined
      ? "held"
      : "running"
    : ownedByThisProcess(record)
      ? "orphaned"
      : await queryLeaseOwner(record, probe.schedule);
  if (owner === "running") return { record, file, owner, roots: [] };
  const directory = dirname(file);
  const roots = await Promise.all(record.roots.map((root) => rootKind(root, directory)));
  return { record, file, owner, roots, busy: await busy(owner, local, record, probe, scan) };
}

/** Whether the owner the lease was assessed with still can't finish it. */
async function stillAbandoned(entry: Assessed, probe: LeaseProbe): Promise<boolean> {
  const local = owned(entry.record.id);
  if (entry.owner === "held") return local !== undefined && local.done && local.quarantined;
  if (local) return false;
  if (entry.owner === "orphaned") return ownedByThisProcess(entry.record);
  return (await queryLeaseOwner(entry.record, probe.schedule)) === "gone";
}

/** Removes the intent after rechecking its owner, then the Git locks its processes left. */
async function retire(
  entry: Assessed,
  probe: LeaseProbe,
  reason: RetiredLease["reason"],
  scan: Scan,
): Promise<boolean> {
  if (!(await stillAbandoned(entry, probe))) return false;
  await rm(entry.file + ".next", { force: true });
  await rm(entry.file, { force: true });
  await syncDirectory(dirname(entry.file));
  orphans.delete(entry.record.id);
  probe.retired?.({
    lease: entry.record,
    repository: journalRepository(dirname(entry.file), entry.record.root),
    reason,
  });
  const evidence = probe.evidence;
  if (evidence && entry.busy?.length === 0) {
    const before = new Date((await evidence.now()).getTime() - lockGraceMs);
    for (const [index, root] of entry.record.roots.entries()) {
      if (entry.roots[index] === "gone") continue;
      await clearLeftoverLocks(root, scan, before).catch(() => []);
    }
  }
  return true;
}

function retirement(entry: Assessed): RetiredLease["reason"] {
  if (entry.owner === "held") return "own_processes_gone";
  if (entry.owner === "orphaned") return "own_lease_processes_gone";
  return entry.roots.every((kind) => kind === "gone" || kind === "unregistered")
    ? "owner_gone_roots_settled"
    : "owner_gone_processes_gone";
}

/** Facts for the intents that still exist, retiring the ones that are definitively stale. */
async function survey(path: string, probe: LeaseProbe, confirmed: boolean) {
  const facts: Assessed[] = [];
  const retired: MutationLease[] = [];
  const scan = memo(probe);
  for (const entry of await records(path)) {
    const assessed = await assess(entry, probe, scan);
    if (assessed.owner !== "running") {
      const automatic = retiresAutomatically(assessed);
      const asked = confirmed && fences(assessed, path) && retiresOnConfirmation(assessed);
      if (
        (automatic || asked) &&
        (await retire(assessed, probe, automatic ? retirement(assessed) : "confirmed_stale", scan))
      ) {
        retired.push(assessed.record);
        continue;
      }
      if ((await text(entry.file)) === undefined) continue; // Successful concurrent retirement.
    }
    facts.push(assessed);
  }
  return { facts, retired };
}

export async function mutationState(
  path: string,
  probe: LeaseProbe = defaultProbe,
): Promise<MutationState> {
  const { facts } = await survey(path, probe, false);
  return leaseState(facts, await realpath(path));
}

function pause(schedule: Schedule, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    schedule(resolve, milliseconds);
  });
}

/**
 * Admission. A lease that clears on its own (a live owner finishing, or a stopped process's
 * lease retiring once its process ends) is waited for, up to `probe.waitMs`. `inside`: the
 * leases the caller itself holds, which can't clear while it waits.
 */
export async function assertAvailable(
  path: string,
  probe: LeaseProbe = defaultProbe,
  inside: ReadonlySet<string> = new Set(),
) {
  const polls = Math.ceil((probe.waitMs ?? 0) / pollMs);
  for (let attempt = 0; ; attempt++) {
    let surveyed;
    let root;
    try {
      root = await realpath(path);
      surveyed = await survey(root, probe, false);
    } catch (error) {
      if (missing(error))
        throw new GitError("not_a_repo", `Git working directory no longer exists: ${path}`);
      throw error;
    }
    const state = leaseState(surveyed.facts, root);
    if (state.status === "available") return;
    const fencing = surveyed.facts.filter((entry) => fences(entry, root));
    const waiting = fencing.every((entry) => !inside.has(entry.record.id) && clearsOnItsOwn(entry));
    if (attempt < polls && waiting) {
      await pause(probe.schedule, pollMs);
      continue;
    }
    throw await refusal(fencing, state);
  }
}

/** The error naming the first fencing lease: which repository, which checkout, what holds it. */
async function refusal(fencing: readonly Assessed[], state: MutationState): Promise<GitError> {
  const first = fencing[0];
  if (!first)
    return new GitError("git_quarantined", "Repository cleanup is unconfirmed", {
      leases: state.leases,
    });
  const since = await stat(first.file).then(
    (info) => info.mtime,
    () => undefined,
  );
  const repository = journalRepository(dirname(first.file), first.record.root);
  return new GitError("git_quarantined", quarantineMessage(first, repository, since), {
    leases: state.leases,
    repository,
    owner: first.owner,
  });
}

/**
 * Right after ace kills a Git process: retire its leases as soon as their operation unwound and
 * each killed process group is gone. Bounded; a group that outlives it is retired by any later
 * admission or sweep that finds it gone.
 */
export async function settleOwnLeases(ids: readonly string[], probe: LeaseProbe, attempts = 40) {
  const scan = memo(probe);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pending = ids.flatMap((id) => {
      const lease = owned(id);
      return lease?.quarantined && lease.groups ? [lease] : [];
    });
    if (!pending.length) return;
    for (const lease of pending) {
      if (!lease.done || !orphans.has(lease.record.id)) continue;
      const directory = dirname(lease.file);
      const roots = await Promise.all(lease.record.roots.map((root) => rootKind(root, directory)));
      const facts: Assessed = { record: lease.record, file: lease.file, owner: "held", roots };
      facts.busy = await busy("held", lease, lease.record, probe, scan);
      if (retiresAutomatically(facts)) await retire(facts, probe, "own_processes_gone", scan);
    }
    if (attempt + 1 < attempts) await pause(probe.schedule, 50);
  }
}

/**
 * "Clear stale lock": the same verification as admission, then retire every fencing intent whose
 * owner is definitively gone. Intents whose owner may still be alive stay, and are returned.
 */
export async function clearStaleLeases(path: string, probe: LeaseProbe = defaultProbe) {
  const root = await realpath(path);
  const { facts, retired } = await survey(root, probe, true);
  const state = leaseState(facts, root);
  if (state.status === "available") return { retired, state };
  const fencing = facts.filter((entry) => fences(entry, root));
  return { retired, state, message: (await refusal(fencing, state)).message };
}

/** Periodic hygiene: retire what is stale, then remove Git locks no live process holds. */
export async function healRepository(
  path: string,
  probe: LeaseProbe = defaultProbe,
  graceMs = 60_000,
): Promise<string[]> {
  await mutationState(path, probe);
  const evidence = probe.evidence;
  if (!evidence) return [];
  const before = new Date((await evidence.now()).getTime() - graceMs);
  return clearLeftoverLocks(path, memo(probe), before);
}
