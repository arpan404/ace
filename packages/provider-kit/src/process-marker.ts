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

/** Every process this user can see whose start environment carries `id`'s marker. */
export function markedProcesses(id: string, listing: ProcessListing): number[] {
  if (!runId.test(id)) return [];
  const found: number[] = [];
  for (const pid of listing.all()) {
    const environment = listing.environment(pid);
    if (environment && carriesOwner(environment, id)) found.push(pid);
  }
  return found;
}
