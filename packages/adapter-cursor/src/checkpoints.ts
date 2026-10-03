import { opendir, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Per-thread store bounds the SDK's full-conversation materialization before pagination. */
export function checkpointDirectory(home: string, threadId: string): string {
  return join(home, ".cursor", "sdk", "ace", createHash("sha256").update(threadId).digest("hex"));
}
export async function checkCheckpointBudget(root: string, maxBytes: number): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe SDK checkpoint directory");
  let bytes = 0;
  let files = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (++files > 16)
      throw new Error("SDK checkpoint inventory exceeds budget; use explicit context handoff");
    const stat = await lstat(join(root, entry.name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe SDK checkpoint entry");
    bytes += stat.size;
    if (bytes > maxBytes)
      throw new Error(
        "SDK checkpoint exceeds recovery budget; preserve source and use explicit context handoff",
      );
  }
}
