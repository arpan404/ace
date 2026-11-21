import type { ProcessListing } from "./process-listing.ts";

/*
 * Every provider, probe and shell started through this package carries
 * `ACE_PROCESS_OWNER=<daemon run id>` in its environment, and their children inherit it unless
 * they deliberately start with a clean one. A daemon run's id is a fresh random id, recorded in
 * its home's run marker, so a marker names one run of one home: a sweep matches it exactly and
 * never reaches another run's or another home's processes.
 *
 * Only these spawns are marked. Processes ace starts to outlive it (an editor it opens, a
 * browser for a sign-in page, the updater) use plain spawns and never carry one.
 */
export const PROCESS_OWNER_ENV = "ACE_PROCESS_OWNER";

/** A run id: what `claimProcessOwner` accepts, so a marker can't be empty or a prefix. */
const runId = /^[A-Za-z0-9-]{16,64}$/;

let claimed: string | undefined;

/**
 * Mark this process's later spawns as `id`'s. The daemon's own inherited marker (it was started
 * from another daemon's agent shell) is dropped, so plain spawns don't carry another run's.
 * Returns the release, which does nothing once another claim replaced this one.
 */
export function claimProcessOwner(id: string, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!runId.test(id)) throw new Error("Invalid process owner id");
  claimed = id;
  delete env[PROCESS_OWNER_ENV];
  return () => {
    if (claimed === id) claimed = undefined;
  };
}

/** The run id this process's spawns carry, if any. */
export function processOwner(): string | undefined {
  return claimed;
}

/** `env` as a marked spawn sees it. */
export function markedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return claimed === undefined ? env : { ...env, [PROCESS_OWNER_ENV]: claimed };
}

/** Whether a start environment carries exactly `id`'s marker. */
export function carriesOwner(environment: readonly string[], id: string): boolean {
  if (!runId.test(id)) return false;
  const entry = `${PROCESS_OWNER_ENV}=${id}`;
  return environment.includes(entry);
}

/**
 * Every process this user can see whose start environment carries `id`'s marker, by identity.
 * Each is read as identity, environment, identity: the environment counts only when both
 * identity reads give the same start, so a pid reused around the environment read is never
 * taken for the marked process. Zombies are left out.
 */
export function markedProcesses(
  id: string,
  listing: ProcessListing,
): { pid: number; start: string }[] {
  if (!runId.test(id)) return [];
  const found: { pid: number; start: string }[] = [];
  for (const pid of listing.all()) {
    const before = listing.info(pid);
    if (!before || before.zombie) continue;
    const environment = listing.environment(pid);
    if (!environment || !carriesOwner(environment, id)) continue;
    const after = listing.info(pid);
    if (after && !after.zombie && after.start === before.start)
      found.push({ pid, start: before.start });
  }
  return found;
}

/*
 * The opposite: processes ace launches on purpose to outlive it (the updater, an editor it
 * opens, a browser for a sign-in page) carry no run marker, and ace records their pid and start
 * as it launches them. Only that record keeps one, and what is below it, from every sweep. They
 * also carry `ACE_PROCESS_KEEP=1`, for people reading a process list, but the variable proves
 * nothing: anything can set it.
 */
export const PROCESS_KEEP_ENV = "ACE_PROCESS_KEEP";

/** `env` for a process ace starts to outlive it. */
export function keptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { ...env, [PROCESS_KEEP_ENV]: "1" };
  delete kept[PROCESS_OWNER_ENV];
  return kept;
}

/** Where a kept process's pid and start go. */
export interface KeptJournal {
  keep(pid: number): void;
}
const keptJournals = new Set<KeptJournal>();
/** Hear each kept process ace launches; returns the unsubscribe. */
export function observeKept(journal: KeptJournal): () => void {
  keptJournals.add(journal);
  return () => keptJournals.delete(journal);
}
/** Record that `pid` was launched to outlive ace. Never throws: a launch has already happened. */
export function noteKept(pid: number | undefined): void {
  if (pid === undefined) return;
  for (const journal of keptJournals)
    try {
      journal.keep(pid);
    } catch (error) {
      process.emitWarning(`A kept process could not be recorded: ${String(error)}`);
    }
}
