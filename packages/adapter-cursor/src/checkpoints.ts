import { opendir, lstat, mkdir } from "node:fs/promises";
import { join, dirname, parse } from "node:path";
import { createHash } from "node:crypto";

/** Per-thread store bounds the SDK's full-conversation materialization before pagination. */
export function checkpointDirectory(home: string, threadId: string): string {
  return join(home, ".cursor", "sdk", "ace", createHash("sha256").update(threadId).digest("hex"));
}
export async function checkCheckpointBudget(
  root: string,
  maxBytes: number,
): Promise<{ bytes: number; files: number }> {
  // Reject symlink ancestors before creating a private store, including a redirected HOME.
  let parent = root;
  while (parent !== parse(parent).root) {
    try {
      const ancestor = await lstat(parent);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
        throw new Error("Unsafe SDK checkpoint ancestor");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    parent = dirname(parent);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe SDK checkpoint directory");
  let bytes = 0;
  let files = 0;
  const pending = [{ path: root, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    const stream = await opendir(directory.path);
    for await (const entry of stream) {
      if (++entries > 128 || directory.depth > 6)
        throw new Error("SDK checkpoint inventory exceeds budget; use explicit context handoff");
      const path = join(directory.path, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Unsafe SDK checkpoint entry");
      if (stat.isDirectory()) {
        pending.push({ path, depth: directory.depth + 1 });
        continue;
      }
      if (!stat.isFile()) throw new Error("Unsafe SDK checkpoint entry");
      files++;
      bytes += stat.size;
      if (bytes > maxBytes)
        throw new Error(
          "SDK checkpoint exceeds recovery budget; preserve source and use explicit context handoff",
        );
    }
  }
  return { bytes, files };
}
