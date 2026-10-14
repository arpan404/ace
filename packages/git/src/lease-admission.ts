import { realpath, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { MutationLease } from "@ace/provider-kit/cleanup";
import { queryLeaseOwner, scheduleProbe, type Schedule } from "./lease-owner.ts";
import { live, missing, records, syncDirectory, text, type JournalEntry } from "./lease-journal.ts";
import { journalRepository, rootKind } from "./lease-roots.ts";
import {
  fences,
  leaseState,
  quarantineMessage,
  retiresAutomatically,
  retiresOnConfirmation,
  type LeaseFacts,
  type MutationState,
} from "./mutation-state.ts";
import { GitError, type RetiredLease } from "./types.ts";

export interface LeaseProbe {
  schedule: Schedule;
  retired?: ((event: RetiredLease) => void) | undefined;
}
export const defaultProbe: LeaseProbe = { schedule: scheduleProbe };

interface Assessed extends LeaseFacts {
  file: string;
}

async function assess({ record, file }: JournalEntry, probe: LeaseProbe): Promise<Assessed> {
  const local = live.get(record.id);
  const owner = local
    ? local.quarantined
      ? "held"
      : "running"
    : await queryLeaseOwner(record, probe.schedule);
  const directory = dirname(file);
  const roots =
    owner === "running"
      ? []
      : await Promise.all(record.roots.map((root) => rootKind(root, directory)));
  return { record, file, owner, roots };
}

/** Removes the intent only after a second probe still finds its owner gone. */
async function retire(
  entry: Assessed,
  probe: LeaseProbe,
  reason: RetiredLease["reason"],
): Promise<boolean> {
  if (live.has(entry.record.id)) return false;
  if ((await queryLeaseOwner(entry.record, probe.schedule)) !== "gone") return false;
  await rm(entry.file + ".next", { force: true });
  await rm(entry.file, { force: true });
  await syncDirectory(dirname(entry.file));
  probe.retired?.({
    lease: entry.record,
    repository: journalRepository(dirname(entry.file), entry.record.root),
    reason,
  });
  return true;
}

/** Facts for the intents that still exist, retiring the ones that are definitively stale. */
async function survey(path: string, probe: LeaseProbe, confirmed: boolean) {
  const facts: Assessed[] = [];
  const retired: MutationLease[] = [];
  for (const entry of await records(path)) {
    const assessed = await assess(entry, probe);
    if (assessed.owner !== "running" && assessed.owner !== "held") {
      const automatic = retiresAutomatically(assessed);
      const asked = confirmed && fences(assessed, path) && retiresOnConfirmation(assessed);
      if (
        (automatic || asked) &&
        (await retire(assessed, probe, automatic ? "owner_gone_roots_settled" : "confirmed_stale"))
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

export async function assertAvailable(path: string, probe: LeaseProbe = defaultProbe) {
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
  const first = surveyed.facts.find((entry) => fences(entry, root));
  if (!first)
    throw new GitError("git_quarantined", "Repository cleanup is unconfirmed", {
      leases: state.leases,
    });
  const since = await stat(first.file).then(
    (info) => info.mtime,
    () => undefined,
  );
  const repository = journalRepository(dirname(first.file), first.record.root);
  throw new GitError("git_quarantined", quarantineMessage(first, repository, since), {
    leases: state.leases,
    repository,
    owner: first.owner,
  });
}

/**
 * "Clear stale lock": the same verification as admission, then retire every fencing intent whose
 * owner is definitively gone. Intents whose owner may still be alive stay, and are returned.
 */
export async function clearStaleLeases(path: string, probe: LeaseProbe = defaultProbe) {
  const root = await realpath(path);
  const { facts, retired } = await survey(root, probe, true);
  return { retired, state: leaseState(facts, root) };
}
