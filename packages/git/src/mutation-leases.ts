import { leaseOwner, queryLeaseOwner } from "./lease-owner.ts";
import {
  assertAvailable,
  defaultProbe,
  mutationState,
  type LeaseProbe,
} from "./lease-admission.ts";
import {
  live,
  missing,
  records,
  scopeJournal,
  syncDirectory,
  type OwnedLease,
} from "./lease-journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CleanupResult, MutationLease, type CleanupReceipt } from "@ace/provider-kit/cleanup";
import { GitError } from "./types.ts";

export { assertAvailable, clearStaleLeases, mutationState } from "./lease-admission.ts";
export type { LeaseProbe } from "./lease-admission.ts";
export { repositoryScope } from "./lease-journal.ts";

// Process-local: the leases each async operation holds, outermost first.
const scope = new AsyncLocalStorage<readonly OwnedLease[]>();

export async function withMutationLease<T>(
  root: string,
  id: () => string,
  operation: () => Promise<T>,
  probe: LeaseProbe = defaultProbe,
): Promise<T> {
  await assertAvailable(root, probe);
  const directory = await scopeJournal(root);
  const endpoint = await leaseOwner(id, (identity) => {
    const owned = live.get(identity);
    return owned ? (owned.quarantined ? "quarantined" : "active") : "unknown";
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
  const owned: OwnedLease = { record, file, quarantined: false, cleanups: [], released, release };
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
    const handle = await open(file, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return await scope.run([...(scope.getStore() ?? []), owned], operation);
  } finally {
    release();
    try {
      if (created && !owned.quarantined) await rm(file, { force: true });
    } finally {
      live.delete(record.id);
    }
  }
}

export function captureMutationOwnership() {
  const held = scope.getStore() ?? [];
  return {
    leases: held.map(({ record }) => record),
    quarantine: (receipt: CleanupReceipt) => quarantine(receipt, held),
  };
}

/** Synchronously deny access before rejecting the caller. Disk intents already exist. */
function quarantine(receipt: CleanupReceipt, held: readonly OwnedLease[]): Promise<CleanupResult> {
  const result = receipt.settled
    .then((raw) => CleanupResult.parse(raw))
    .catch((): CleanupResult => ({
      status: "unconfirmed",
      reason: "Cleanup supervisor failed",
    }));
  for (const owned of held) {
    owned.quarantined = true;
    owned.cleanups.push(result);
  }
  return result.then(async (outcome): Promise<CleanupResult> => {
    if (outcome.status !== "confirmed") return outcome;
    await Promise.all(held.map((owned) => owned.released));
    const outcomes = await Promise.all(held.flatMap((owned) => owned.cleanups));
    if (outcomes.some((value) => value.status !== "confirmed"))
      return { status: "unconfirmed", reason: "Other owned processes have unconfirmed cleanup" };
    try {
      await Promise.all(held.map((owned) => rm(owned.file, { force: true })));
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
  if (outcomes.every((result) => result.status === "confirmed"))
    await Promise.all(discovered.map(({ file }) => rm(file, { force: true })));
  return mutationState(path, probe);
}

export const mutationLeaseId = randomUUID;
