import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The desktop app leaves the daemon it started running when it quits, so the next launch hands
 * the page a daemon at once (ADR 0186). This record, in the daemon's home, is how a later launch
 * knows that daemon is the app's: it names the run by the pid and the per-run id the daemon
 * wrote in its `daemon-lock`, which no other daemon (the CLI's, the login service's) can share.
 */
export const ownershipFile = "app-daemon.json";

const LockOwner = z.object({ pid: z.number().int().positive(), id: z.string().min(1).max(128) });
export type LockOwner = z.infer<typeof LockOwner>;

export const OwnershipRecord = z.object({
  pid: z.number().int().positive(),
  /** The `id` in the daemon's `daemon-lock` for this run. */
  lockId: z.string().min(1).max(128),
  /** The app version that started it, which is the version of the daemon it bundles. */
  version: z.string().min(1).max(128),
  /** When the app saw it running, in milliseconds since the epoch. */
  startedAt: z.number(),
});
export type OwnershipRecord = z.infer<typeof OwnershipRecord>;

/** What a launch does with the daemon it found answering in its home. */
export type FoundDaemon =
  /** Someone else's (the CLI, the login service, another build's app): used, never stopped. */
  | { kind: "external" }
  /** The app's own, from this version: supervised as if this launch had started it. */
  | { kind: "adopt"; pid: number; lockId: string }
  /** The app's own, from another version: drained, stopped and replaced by the bundled one. */
  | { kind: "replace"; pid: number; lockId: string; version: string };

/**
 * Whether the daemon holding the home's lock is one an ace app started, and what to do with it.
 * Only a record whose pid and lock id both match the running daemon's lock counts: a record
 * left from an earlier run never claims a daemon started since by anyone else.
 */
export function foundDaemon(
  record: OwnershipRecord | undefined,
  lock: LockOwner | undefined,
  appVersion: string,
): FoundDaemon {
  if (!record || !sameRun(lock, record)) return { kind: "external" };
  const run = { pid: record.pid, lockId: record.lockId };
  return record.version === appVersion
    ? { kind: "adopt", ...run }
    : { kind: "replace", ...run, version: record.version };
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse((await readFile(path, "utf8")).slice(0, 4096)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the home's lock names exactly this run: the same pid and the same run id. */
export function sameRun(
  lock: LockOwner | undefined,
  run: { pid: number; lockId: string },
): boolean {
  return lock?.pid === run.pid && lock.id === run.lockId;
}

/** The pid and run id in the home's `daemon-lock`, when there is a readable one. */
export function readLockOwner(home: string): Promise<LockOwner | undefined> {
  return readJson(join(home, "daemon-lock"), LockOwner);
}

export function readOwnership(home: string): Promise<OwnershipRecord | undefined> {
  return readJson(join(home, ownershipFile), OwnershipRecord);
}

/**
 * Written whole and renamed into place, so a reader never sees half a record; each write has its
 * own partial file, so two at once both land.
 */
export async function writeOwnership(home: string, record: OwnershipRecord): Promise<void> {
  const path = join(home, ownershipFile);
  const partial = `${path}.${randomUUID()}.tmp`;
  await writeFile(partial, JSON.stringify(record), { mode: 0o600 });
  await rename(partial, path);
}
