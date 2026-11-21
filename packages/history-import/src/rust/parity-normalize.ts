import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the parity homes are made. Source ids hash their paths and lists break ties by id, so the
 * frozen observation holds only for homes at this one absolute path (macOS and Linux).
 */
export const parityRoot = "/tmp/ace-history-parity";

/** One instant every fixture file is stamped with, so sizes, titles and activity are stable. */
const STAMP = new Date("2026-06-01T00:00:00.000Z");

/** Stamp every file under `root` with one modification time. */
export async function stamp(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), STAMP, STAMP);
}

/** An observation with file fingerprints (device, inode and change time) written out of it. */
export function normalize(observation: unknown): unknown {
  return JSON.parse(
    JSON.stringify(observation).replaceAll(
      /"fingerprint":"[^"]*"/g,
      '"fingerprint":"<fingerprint>"',
    ),
  );
}
