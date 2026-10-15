import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The generation of persisted data this build reads and writes in ACE_HOME.
 *
 * Bump this by one in the same change that alters any persisted format an older build cannot
 * read: a SQLite schema or migration in any database under ACE_HOME (events, accounts, models,
 * notifications, forge, processes, ...), a new enum value stored in a row, or a JSON state file.
 * A build whose generation is lower than the one recorded in ACE_HOME refuses to start before it
 * opens any database, instead of starting degraded on data it cannot read (issue #712).
 * Never decrease it.
 */
export const DATA_GENERATION = 1;

/** `ACE_HOME/data-generation`: `{"generation":N}`, replaced atomically. */
export const DATA_GENERATION_FILE = "data-generation";

const Recorded = z.looseObject({ generation: z.number().int().nonnegative() });

/** Raised before any database opens when ACE_HOME holds data from a newer build. */
export class NewerDataError extends Error {
  readonly home: string;
  readonly stored: number;
  readonly supported: number;
  constructor(home: string, stored: number, supported: number) {
    super(
      `This ace build is older than the data in ${home}: data generation ${stored}, build supports ${supported}. Open the newest ace or update this one.`,
    );
    this.name = "NewerDataError";
    this.home = home;
    this.stored = stored;
    this.supported = supported;
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The generation recorded in `home`, or undefined when no build has recorded one yet. */
export function readDataGeneration(home: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, DATA_GENERATION_FILE), "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Cannot read the data generation in ${home}`, { cause });
  }
  const recorded = Recorded.safeParse(parsed);
  if (!recorded.success)
    throw new Error(`Cannot read the data generation in ${home}`, { cause: recorded.error });
  return recorded.data.generation;
}

/** Throws NewerDataError when `home` holds data from a build newer than `supported`. */
export function assertDataGeneration(home: string, supported = DATA_GENERATION): void {
  const stored = readDataGeneration(home);
  if (stored !== undefined && stored > supported) throw new NewerDataError(home, stored, supported);
}

/**
 * Records `supported` in `home` unless an equal or newer generation is already there. Call it
 * while holding the daemon lock, after `assertDataGeneration`; it checks again, so a newer
 * build that recorded in between is still refused.
 */
export function recordDataGeneration(home: string, supported = DATA_GENERATION): void {
  const stored = readDataGeneration(home);
  if (stored !== undefined && stored > supported) throw new NewerDataError(home, stored, supported);
  if (stored === supported) return;
  const path = join(home, DATA_GENERATION_FILE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ generation: supported })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
