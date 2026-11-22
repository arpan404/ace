import { lstat, mkdir } from "node:fs/promises";
import { join, dirname, parse } from "node:path";
import { createHash } from "node:crypto";

/** Per-thread store bounds the SDK's full-conversation materialization before pagination.
 * The byte budget is adjustable per thread via `Limits.maxCheckpointBytes`
 * (`DaemonOptions.engine.cursor.limits`, default 8 GiB, max 64 GiB). */
export function checkpointDirectory(home: string, threadId: string, generation = 0): string {
  const key = createHash("sha256").update(threadId).digest("hex");
  // A later generation is a fresh session after the earlier store became unusable (ADR 0211);
  // the earlier folders stay where they are, untouched.
  return join(home, ".cursor", "sdk", "ace", generation > 0 ? `${key}-g${generation}` : key);
}
/** Shared SDK home/checkpoint ancestor gate; does not read credentials or create files. */
export async function validatePrivateDirectory(root: string): Promise<void> {
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
}
/** Creates the thread's private checkpoint folder, refusing a symlink anywhere on its path. */
export async function prepareCheckpointDirectory(root: string): Promise<void> {
  await validatePrivateDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe SDK checkpoint directory");
}
/** The files that hold a store's weight: the SDK index, its legacy JSONL, an agent's store.db. */
function storeFiles(root: string, agentId: string | undefined): string[] {
  const files = [
    "index.db",
    "agents.ndjson",
    "runs.ndjson",
    "checkpoints.ndjson",
    "run_events.ndjson",
  ].map((name) => join(root, name));
  if (agentId) {
    const agent = `agent-${createHash("sha256").update(agentId).digest("hex")}`;
    files.push(join(root, "agents", agent, "store.db"));
  }
  return files.flatMap((file) => (file.endsWith(".db") ? [file, `${file}-wal`] : [file]));
}
/**
 * The checkpoint's size from a fixed handful of files, never a directory walk (ADR 0043,
 * amendment of 2026-11-22). A file that is missing weighs nothing; one that is not a plain file
 * is refused.
 */
export async function checkpointBytes(root: string, agentId?: string): Promise<number> {
  let bytes = 0;
  for (const file of storeFiles(root, agentId)) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe SDK checkpoint entry");
      bytes += stat.size;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return bytes;
}
/** Words store-fence.ts reads as an unusable store: the next open hands off (ADR 0211). */
export const overBudget = "SDK checkpoint exceeds its budget; use context handoff";
/** Throws `overBudget` when the store has outgrown `maxBytes`. */
export async function assertCheckpointBudget(
  root: string,
  maxBytes: number,
  agentId?: string,
): Promise<void> {
  if ((await checkpointBytes(root, agentId)) > maxBytes) throw new Error(overBudget);
}
