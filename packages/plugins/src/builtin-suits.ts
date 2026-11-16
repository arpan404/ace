import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFolder, unpackArchive } from "@ace/files";
import {
  folderHash,
  needsFolderHash,
  parseInstalledLock,
  planShipped,
  readBuiltinsLock,
  type InstalledLock,
  type ShippedEntry,
} from "./builtin-lock.ts";

// Resolved on use, like the shipped skills; the release bundle copies both beside it.
const shippedRoot = () => fileURLToPath(new URL("../builtin-suits", import.meta.url));
const shippedLock = () => fileURLToPath(new URL("../builtins-lock.json", import.meta.url));

/** Where the shipped Suits are and the lock that versions them. */
export interface ShippedSuits {
  root: string;
  lock: string;
}

/** The library's record of the shipped Suits it holds (`InstalledLock`). */
const lockName = ".ace-lock.json";
/** Ids offered by releases before the lock, one per line; read once, then replaced. */
const legacyName = ".shipped";

/** A shipped Suit packed into one file by `packBuiltinSuits`. */
const packed = ".tar";

export interface SeedResult {
  /** Shipped Suits copied in for the first time. */
  installed: string[];
  /** Older shipped copies the person never changed, replaced with this release's. */
  updated: string[];
  /** Shipped Suits whose files don't match `builtins-lock.json`, left alone. */
  stale: string[];
}

/**
 * Brings a person's Suit library (ADR 0150) up to the Suits this release ships, by the
 * versions in `builtins-lock.json`:
 * - a Suit the library hasn't had is copied in;
 * - a copy still holding a version ace shipped is replaced with this release's;
 * - a copy the person changed, a folder of theirs under a shipped id, and a Suit they deleted
 *   are theirs, and are never touched again.
 *
 * Folders are hashed only when the shipped version moved on, so a start with nothing new reads
 * one small file. A replacement is staged under a dot name and swapped in, and a run that fails
 * part-way records only what it finished, so the next start finishes the rest.
 *
 * The shipped root holds each Suit as a folder (the repo) or as `<id>.tar` (a release, see
 * `packBuiltinSuits`).
 */
export async function seedBuiltinSuits(
  library: string,
  shipped: ShippedSuits = { root: shippedRoot(), lock: shippedLock() },
): Promise<SeedResult> {
  await mkdir(library, { recursive: true });
  await settleInterrupted(library);
  const versions = (await readBuiltinsLock(shipped.lock)).suits;
  const lock = await readInstalled(library);
  const offeredBefore = lock ? new Set<string>() : await readLegacy(library);
  const installed: InstalledLock = lock ?? { lockVersion: 1, items: {} };
  const present = new Set(await readdir(library));
  const suits = (await readdir(shipped.root, { withFileTypes: true }))
    .flatMap((entry) => {
      const id = shippedId(entry);
      return id === undefined
        ? []
        : [{ id, path: join(shipped.root, entry.name), folder: entry.isDirectory() }];
    })
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: SeedResult = { installed: [], updated: [], stale: [] };
  let changed = lock === undefined;
  try {
    for (const suit of suits) {
      const version = versions[suit.id];
      if (!version) {
        result.stale.push(suit.id);
        continue;
      }
      const facts = {
        shipped: version,
        entry: installed.items[suit.id],
        offeredBefore: offeredBefore.has(suit.id),
        present: present.has(suit.id),
      };
      const hash = needsFolderHash(facts) ? await folderHash(join(library, suit.id)) : undefined;
      const { action, record } = planShipped({ ...facts, folderHash: hash });
      if (action === "install" || action === "replace") {
        if (!(await place(library, suit, version, action === "replace"))) {
          result.stale.push(suit.id);
          continue;
        }
        result[action === "install" ? "installed" : "updated"].push(suit.id);
      }
      const before = installed.items[suit.id];
      if (
        before?.version !== record.version ||
        before.hash !== record.hash ||
        before.state !== record.state
      ) {
        installed.items[suit.id] = record;
        changed = true;
      }
    }
  } finally {
    if (changed) await writeInstalled(library, installed);
  }
  if (lock === undefined) await rm(join(library, legacyName), { force: true });
  return result;
}

/**
 * Copies one shipped Suit into the library: whole under a dot name the library ignores, checked
 * against its lock hash, then moved in (over the old copy when replacing), so a crash never
 * leaves a half-copied Suit. False when the files don't match the lock.
 */
async function place(
  library: string,
  suit: { id: string; path: string; folder: boolean },
  version: ShippedEntry,
  replacing: boolean,
): Promise<boolean> {
  const staging = join(library, `.seeding-${suit.id}`);
  await rm(staging, { recursive: true, force: true });
  if (suit.folder) await cp(suit.path, staging, { recursive: true });
  else {
    await mkdir(staging);
    await unpackArchive(suit.path, staging);
  }
  if ((await folderHash(staging)) !== version.hash) {
    await rm(staging, { recursive: true, force: true });
    return false;
  }
  const target = join(library, suit.id);
  if (!replacing) {
    await rename(staging, target);
    return true;
  }
  const old = join(library, `.replaced-${suit.id}`);
  await rm(old, { recursive: true, force: true });
  await rename(target, old);
  await rename(staging, target);
  await rm(old, { recursive: true, force: true });
  return true;
}

/** After a crash mid-replace: an old copy whose new one never moved in goes back. */
async function settleInterrupted(library: string): Promise<void> {
  const names = new Set(await readdir(library));
  for (const name of names) {
    if (name.startsWith(".seeding-"))
      await rm(join(library, name), { recursive: true, force: true });
    if (!name.startsWith(".replaced-")) continue;
    const id = name.slice(".replaced-".length);
    if (names.has(id)) await rm(join(library, name), { recursive: true, force: true });
    else await rename(join(library, name), join(library, id));
  }
}

/**
 * Writes each shipped Suit folder into `output` as one `<id>.tar`, for the release archive:
 * installed updaters refuse an archive over their entry budget (`releaseArchiveLimits` in
 * `@ace/service`), and a Suit's fonts and thumbnails would otherwise be an entry each.
 */
export async function packBuiltinSuits(output: string, root = shippedRoot()): Promise<string[]> {
  await mkdir(output, { recursive: true });
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const id of ids) await packFolder(join(root, id), join(output, id + packed));
  return ids;
}

function shippedId(entry: Dirent): string | undefined {
  if (entry.isDirectory()) return entry.name;
  if (entry.isFile() && entry.name.endsWith(packed)) return entry.name.slice(0, -packed.length);
  return undefined;
}

async function readInstalled(library: string): Promise<InstalledLock | undefined> {
  const text = await readOptional(join(library, lockName));
  return text === undefined ? undefined : parseInstalledLock(text);
}

async function readLegacy(library: string): Promise<Set<string>> {
  const text = (await readOptional(join(library, legacyName))) ?? "";
  return new Set(text.split("\n").filter((line) => line.length > 0));
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeInstalled(library: string, lock: InstalledLock): Promise<void> {
  const path = join(library, lockName);
  const items = Object.fromEntries(
    Object.entries(lock.items).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  await writeFile(`${path}.tmp`, JSON.stringify({ lockVersion: 1, items }, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
