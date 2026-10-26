import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { releaseArchiveLimits, syncTree } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A release tree with `files` regular files spread over `directories` folders. */
async function release(files: number, directories: number) {
  const root = await mkdtemp(join(tmpdir(), "ace-sync-tree-"));
  roots.push(root);
  for (let index = 0; index < directories; index++)
    await mkdir(join(root, `package-${index}`), { recursive: true });
  for (let index = 0; index < files; index++)
    await writeFile(join(root, `package-${index % directories}`, `file-${index}`), "x");
  return root;
}

test(
  "a release at the archive's file budget installs even though its folders add more entries",
  { timeout: 60_000 },
  async () => {
    // The linux-arm64 daemon release has 1,920 files in 283 folders: 2,203 entries in all.
    const root = await release(releaseArchiveLimits.entries, 300);
    await expect(syncTree(root)).resolves.toBeUndefined();
    await writeFile(join(root, "package-0", "one-too-many"), "x");
    await expect(syncTree(root)).rejects.toThrow("Release file limit exceeded");
  },
);
