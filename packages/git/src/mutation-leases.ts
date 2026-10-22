import { leaseOwner, queryLeaseOwner } from "./lease-owner.ts";
import {
  assertAvailable as admit,
  defaultProbe,
  mutationState,
  type LeaseProbe,
} from "./lease-admission.ts";
import {
  live,
  missing,
  orphans,
  owned as ownedLease,
  records,
  scopeJournal,
  syncDirectory,
  type OwnedLease,
} from "./lease-journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CleanupResult, MutationLease, type CleanupReceipt } from "@ace/provider-kit/cleanup";
import { GitError } from "./types.ts";

export {
  clearStaleLeases,
  healRepository,
  mutationState,
  settleOwnLeases,
} from "./lease-admission.ts";
export type { LeaseProbe } from "./lease-admission.ts";

// Process-local: the leases each async operation holds, outermost first.
const scope = new AsyncLocalStorage<readonly OwnedLease[]>();

/** Admission for the calling operation, which never waits for the leases it holds itself. */
export function assertAvailable(path: string, probe: LeaseProbe = defaultProbe) {
  const held = scope.getStore() ?? [];
  return admit(path, probe, new Set(held.map(({ record }) => record.id)));
}

export async function withMutationLease<T>(
  root: string,
  id: () => string,
  operation: () => Promise<T>,
  probe: LeaseProbe = defaultProbe,
): Promise<T> {
  await assertAvailable(root, probe);
  const directory = await scopeJournal(root);
  const endpoint = await leaseOwner(id, (identity) => {
    const held = ownedLease(identity);
    return held ? (held.quarantined ? "quarantined" : "active") : "unknown";
  });
  const record = MutationLease.parse({
    version: 1,
    id: id(),
    root,
    roots: [root],
    owner: endpoint,
  });
  const file = join(directory, record.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const owned: OwnedLease = {
    record,
    file,
    quarantined: false,
    cleanups: [],
    released,
    release,
    done: false,
    groups: [],
  };
  // The intent reaches disk before any process can mutate this root. A crash leaves
  // an intent whose owner is gone, which a restarted daemon fences until it is settled.
  const ancestors = scope.getStore() ?? [];
  for (const ancestor of ancestors) {
    ancestor.record = MutationLease.parse({
      ...ancestor.record,
      roots: [...new Set([...ancestor.record.roots, root])],
    });
    const update = await open(ancestor.file + ".next", "w", 0o600);
    try {
      await update.writeFile(JSON.stringify(ancestor.record));
      await update.sync();
    } finally {
      await update.close();
    }
    await rename(ancestor.file + ".next", ancestor.file);
    await syncDirectory(dirname(ancestor.file));
  }
  if (live.has(record.id)) throw new GitError("git_busy", "Mutation lease identity already active");
  live.set(record.id, owned);
  let created = false;
  try {
    // Written whole under a name readers skip, then linked into place: another daemon reading
    // the journal never sees an empty or half-written lease. The link keeps creation exclusive.
    const pending = file + ".next";
    const handle = await open(pending, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(pending, file);
      created = true;
    } finally {
      await rm(pending, { force: true });
    }
    await syncDirectory(directory);
    return await scope.run([...(scope.getStore() ?? []), owned], operation);
  } finally {
    owned.done = true;
    release();
    try {
      if (created && !owned.quarantined) await rm(file, { force: true });
    } finally {
      live.delete(record.id);
      // A killed process may outlive the operation. Remember the lease until it is retired.
      if (created && owned.quarantined) orphans.set(record.id, owned);
    }
  }
}

export function captureMutationOwnership() {
  const held = scope.getStore() ?? [];
  return {
    leases: held.map(({ record }) => record),
    /** `group`: the killed POSIX process group, when ace killed it without a supervisor. */
    quarantine: (receipt: CleanupReceipt, group?: number) => quarantine(receipt, held, group),
  };
}

/** Synchronously deny access before rejecting the caller. Disk intents already exist. */
function quarantine(
  receipt: CleanupReceipt,
  held: readonly OwnedLease[],
  group: number | undefined,
): Promise<CleanupResult> {
  const result = receipt.settled
    .then((raw) => CleanupResult.parse(raw))
    .catch((): CleanupResult => ({
      status: "unconfirmed",
      reason: "Cleanup supervisor failed",
    }));
  for (const owned of held) {
    owned.quarantined = true;
    owned.cleanups.push(result);
    // Without ace's own group to watch, only the supervisor's receipt can settle the lease.
    owned.groups = group === undefined ? undefined : owned.groups && [...owned.groups, group];
  }
  return result.then(async (outcome): Promise<CleanupResult> => {
    if (outcome.status !== "confirmed") return outcome;
    await Promise.all(held.map((owned) => owned.released));
    const outcomes = await Promise.all(held.flatMap((owned) => owned.cleanups));
    if (outcomes.some((value) => value.status !== "confirmed"))
      return { status: "unconfirmed", reason: "Other owned processes have unconfirmed cleanup" };
    try {
      await Promise.all(held.map((owned) => rm(owned.file, { force: true })));
      for (const owned of held) orphans.delete(owned.record.id);
    } catch {
      return { status: "unconfirmed", reason: "Cannot retire durable mutation leases" };
    }
    return outcome;
  });
}

export async function recoverMutationLeases(
  path: string,
  recover: (lease: MutationLease) => Promise<CleanupResult>,
  probe: LeaseProbe = defaultProbe,
) {
  const discovered = await records(path);
  const seen = new Set(discovered.map(({ record }) => record.id));
  for (let index = 0; index < discovered.length; index++) {
    for (const root of discovered[index]?.record.roots ?? []) {
      const nested = await records(root).catch((error: unknown) => {
        if (missing(error)) return []; // A removed root has no journal of its own left.
        throw error;
      });
      for (const entry of nested) {
        if (seen.has(entry.record.id)) continue;
        seen.add(entry.record.id);
        discovered.push(entry);
      }
    }
  }
  if (discovered.some(({ record }) => live.has(record.id))) return mutationState(path, probe);
  for (const { record } of discovered) {
    if ((await queryLeaseOwner(record, probe.schedule)) === "active")
      return mutationState(path, probe);
  }
  const outcomes: CleanupResult[] = [];
  for (const { record } of discovered) {
    try {
      outcomes.push(CleanupResult.parse(await recover(record)));
    } catch {
      outcomes.push({ status: "unconfirmed", reason: "Cleanup supervisor failed" });
    }
  }
  // A parent must stay fenced until every captured descendant is confirmed.
  if (outcomes.every((result) => result.status === "confirmed")) {
    await Promise.all(discovered.map(({ file }) => rm(file, { force: true })));
    for (const { record } of discovered) orphans.delete(record.id);
  }
  return mutationState(path, probe);
}

export const mutationLeaseId = randomUUID;
