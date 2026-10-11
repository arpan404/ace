import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { releaseArchiveLimits, unpackArchive } from "@ace/service";

/** Enumerate only regular files, exactly once, as the installed updater expects. */
export async function releaseFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await releaseFiles(root, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsafe release entry: ${path}`);
    if (result.length > releaseArchiveLimits.entries)
      throw new Error("Release exceeds the supported updater entry budget");
  }
  return result.toSorted();
}

/** Validate the exact completed archive through the consumer before advertising it. */
export async function validateReleaseArchive(file: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "ace-archive-validation-"));
  try {
    await unpackArchive(file, join(temporary, "unpacked"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createReleaseArchive(root: string, file: string): Promise<void> {
  try {
    await create(
      { cwd: root, file, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true },
      await releaseFiles(root),
    );
    await validateReleaseArchive(file);
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}
