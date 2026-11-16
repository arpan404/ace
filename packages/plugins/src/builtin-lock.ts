import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Versions of what ace ships (`builtins-lock.json` beside `builtin-skills` and `builtin-suits`).
 * Each built-in has a version that goes up by one whenever its files change, the hash of its
 * files, and every hash it shipped with before. A copy in a person's library that still holds
 * one of those hashes is ace's own and can be replaced on update; anything else is theirs.
 *
 * `bun run builtins:lock` rewrites the file; `bun run check:builtins` fails when it's stale.
 */
export interface ShippedEntry {
  version: number;
  hash: string;
  /** Hashes of earlier versions, newest first. */
  previous: string[];
}
export interface BuiltinsLock {
  lockVersion: 1;
  skills: Record<string, ShippedEntry>;
  suits: Record<string, ShippedEntry>;
}

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ShippedEntrySchema = z.object({
  version: z.number().int().positive(),
  hash: Hash,
  previous: z.array(Hash),
});
const BuiltinsLockSchema = z.object({
  lockVersion: z.literal(1),
  skills: z.record(z.string(), ShippedEntrySchema),
  suits: z.record(z.string(), ShippedEntrySchema),
});

export async function readBuiltinsLock(path: string): Promise<BuiltinsLock> {
  return BuiltinsLockSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Files the OS leaves in folders a person only looked at. Nothing else is skipped: anything a
 * person adds to a shipped copy, hidden or not, makes it theirs, so an update never deletes it.
 */
const osClutter = (name: string) =>
  name === ".DS_Store" || name.startsWith("._") || name === "Thumbs.db" || name === "desktop.ini";

/**
 * The hash of a folder: every entry below it (files, folders, links) by `/`-separated relative
 * path, sorted, with the SHA-256 of a file's bytes or a link's target. OS clutter (`osClutter`) is left out, so a
 * Finder visit doesn't make a copy look edited, and a folder hashes the same whether it came
 * from the repo or from a release's packed archive.
 */
export async function folderHash(folder: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (osClutter(entry.name)) continue;
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        // Listed itself, so an empty folder a person adds counts as a change too.
        lines.push(`${name}/\0dir\n`);
        await walk(path, `${name}/`);
      } else if (entry.isFile())
        lines.push(
          `${name}\0${createHash("sha256")
            .update(await readFile(path))
            .digest("hex")}\n`,
        );
      else if (entry.isSymbolicLink()) lines.push(`${name}\0link\0${await readlink(path)}\n`);
      else lines.push(`${name}\0other\n`);
    }
  };
  await walk(folder, "");
  const hash = createHash("sha256");
  for (const line of lines.toSorted()) hash.update(line);
  return hash.digest("hex");
}

/**
 * The next lock from the current one and each built-in's hash now: an unchanged built-in keeps
 * its entry, a changed one goes up a version and keeps its old hash in `previous`, a new one
 * starts at 1, and one no longer shipped is dropped.
 */
export function nextBuiltinsLock(
  current: BuiltinsLock | undefined,
  hashes: { skills: Record<string, string>; suits: Record<string, string> },
): BuiltinsLock {
  return {
    lockVersion: 1,
    skills: nextEntries(current?.skills, hashes.skills),
    suits: nextEntries(current?.suits, hashes.suits),
  };
}

function nextEntries(
  old: Record<string, ShippedEntry> = {},
  now: Record<string, string>,
): Record<string, ShippedEntry> {
  return Object.fromEntries(
    Object.keys(now)
      .toSorted()
      .map((name): [string, ShippedEntry] => {
        const hash = now[name] ?? "";
        const before = old[name];
        if (!before) return [name, { version: 1, hash, previous: [] }];
        if (before.hash === hash) return [name, before];
        const previous = [before.hash, ...before.previous].filter(
          (seen, at, all) => seen !== hash && all.indexOf(seen) === at,
        );
        return [name, { version: before.version + 1, hash, previous }];
      }),
  );
}

/**
 * What a person's library holds of one built-in (`.ace-lock.json` in the library):
 * - `installed`: ace put version `version` (files `hash`) there and may replace it on update.
 * - `kept`: the folder was changed by the person, or was theirs before ace shipped that id;
 *   ace never touches it again.
 * - `removed`: the person deleted it; ace never copies it back.
 */
export interface InstalledEntry {
  version: number;
  hash: string;
  state: "installed" | "kept" | "removed";
}
export interface InstalledLock {
  lockVersion: 1;
  items: Record<string, InstalledEntry>;
}
const InstalledEntrySchema = z.object({
  version: z.number().int().nonnegative(),
  hash: z.string(),
  state: z.enum(["installed", "kept", "removed"]),
});

/** Leniently: an entry that doesn't parse is dropped, so its folder is judged again by hash. */
export function parseInstalledLock(text: string): InstalledLock {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { lockVersion: 1, items: {} };
  }
  const items: Record<string, InstalledEntry> = {};
  if (typeof data === "object" && data !== null && "items" in data) {
    const raw = data.items;
    if (typeof raw === "object" && raw !== null)
      for (const [id, value] of Object.entries(raw)) {
        const entry = InstalledEntrySchema.safeParse(value);
        if (entry.success) items[id] = entry.data;
      }
  }
  return { lockVersion: 1, items };
}

export interface ShippedFacts {
  shipped: ShippedEntry;
  /** What the library's lock says about this id, if anything. */
  entry: InstalledEntry | undefined;
  /** The id was offered by a release older than the lock (the old `.shipped` list). */
  offeredBefore: boolean;
  /** A folder with this id is in the library. */
  present: boolean;
  /** The folder's `folderHash`; only needed when `needsFolderHash` says so. */
  folderHash?: string | undefined;
}
export type ShippedAction = "install" | "replace" | "current" | "keep" | "removed";

/** Whether `planShipped` needs the folder hashed: only when the shipped version moved on. */
export function needsFolderHash(facts: Omit<ShippedFacts, "folderHash">): boolean {
  const { entry, shipped, present } = facts;
  if (!present || entry?.state === "kept" || entry?.state === "removed") return false;
  return !(entry?.state === "installed" && entry.hash === shipped.hash);
}

/** What to do with one shipped built-in, and the library lock entry to record after it. */
export function planShipped(facts: ShippedFacts): {
  action: ShippedAction;
  record: InstalledEntry;
} {
  const { shipped, entry, offeredBefore, present } = facts;
  const ours: InstalledEntry = { version: shipped.version, hash: shipped.hash, state: "installed" };
  if (entry?.state === "kept" || entry?.state === "removed")
    return { action: entry.state === "kept" ? "keep" : "removed", record: entry };
  if (!present)
    return entry || offeredBefore
      ? { action: "removed", record: { ...ours, state: "removed" } }
      : { action: "install", record: ours };
  if (entry?.hash === shipped.hash || facts.folderHash === shipped.hash)
    return { action: "current", record: ours };
  const known = new Set(shipped.previous);
  if (entry) known.add(entry.hash);
  if (facts.folderHash !== undefined && known.has(facts.folderHash))
    return { action: "replace", record: ours };
  return {
    action: "keep",
    record: { version: entry?.version ?? 0, hash: facts.folderHash ?? "", state: "kept" },
  };
}
