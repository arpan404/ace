import { validateLegacyCheckpoint } from "./legacy-checkpoints.ts";
import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { agentStorePath } from "./checkpoints.ts";
import { z } from "zod";
import { boundedJson } from "@ace/provider-kit/ipc";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import type { SdkModule } from "./host-runtime.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
/** Use Cursor's transactional format for new threads; preserve existing SDK JSONL stores. */
export async function openSdkCheckpointStore(
  sdk: Pick<SdkModule, "JsonlLocalAgentStore">,
  root: string,
  cwd: string,
  maxBytes = 33_554_432,
): Promise<{ store: LocalAgentStore; kind: "sqlite" | "jsonl"; close(): Promise<void> }> {
  const sqlite = await exists(join(root, "index.db"));
  const names = ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"];
  const legacyFiles = await Promise.all(names.map((name) => exists(join(root, name))));
  const jsonl = legacyFiles[0] === true;
  if (!jsonl && legacyFiles.some(Boolean))
    throw new Error("Incomplete SDK JSONL checkpoint; preserve source and use context handoff");
  if (sqlite && jsonl)
    throw new Error("SDK checkpoint formats conflict; preserve source and use context handoff");
  if (jsonl) {
    for (const [index, name] of names.entries())
      if (legacyFiles[index]) await validateLegacyCheckpoint(join(root, name), maxBytes);
    return { store: new sdk.JsonlLocalAgentStore(root), kind: "jsonl", close: async () => {} };
  }
  // This public SDK subpath is imported only in the selected home's supervised Node worker.
  const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
  const store = await SqliteLocalAgentStore.open({ stateRoot: root, workspaceRef: cwd });
  return { store, kind: "sqlite", close: () => store.dispose() };
}
const CheckpointIdentity = z.object({
  agentId: z.string().min(1).max(512),
  latestCheckpoint: z
    .object({ schemaVersion: z.literal(1), rootBlobId: z.string().min(1).max(512) })
    .nullable()
    .optional(),
  updatedAt: z.number().finite().nonnegative(),
});
/** Native content-addressed checkpoint revision; SQLite lock/WAL bookkeeping is not history. */
export async function checkpointRevision(store: LocalAgentStore, agentId: string): Promise<string> {
  const document = CheckpointIdentity.parse(await store.agents.get({ agentId }));
  if (document.agentId !== agentId) throw new Error("SDK snapshot agent identity changed");
  if (
    !document.latestCheckpoint ||
    !(await store.checkpoints.get({ agentId, blobId: document.latestCheckpoint.rootBlobId }))
  )
    throw new Error(
      "SDK native conversation checkpoint is missing; preserve source and use explicit context handoff",
    );
  return createHash("sha256").update(boundedJson(document, 2048)).digest("hex");
}

/**
 * `store`, telling `appended` each run event the SDK stores, in order, once it is stored (the
 * SDK stores an update's event next to handing the update to onDelta: run-seams.ts), and
 * telling `creating` each run the SDK is about to create, and waiting for it first: so ace has
 * the run's id before the run can exist, and a run it has no id for was never created.
 */
export function observeRunEvents(
  store: LocalAgentStore,
  appended: (event: { runId: string; seq: number; offset: string; payload: unknown }) => void,
  creating: (runId: string) => Promise<void> = async () => {},
): LocalAgentStore {
  return {
    ...store,
    runs: {
      get: (input) => store.runs.get(input),
      list: (input) => store.runs.list(input),
      update: (input) => store.runs.update(input),
      delete: (input) => store.runs.delete(input),
      create: async (input) => {
        await creating(input.run.runId);
        return store.runs.create(input);
      },
    },
    runEvents: {
      list: (input) => store.runEvents.list(input),
      delete: (input) => store.runEvents.delete(input),
      append: async (input) => {
        const stored = await store.runEvents.append(input);
        appended({
          runId: stored.runId,
          seq: stored.seq,
          offset: stored.offset,
          payload: input.payload,
        });
        return stored;
      },
    },
  };
}
/**
 * Throws, saying SQLITE_BUSY, when another process holds one of the SDK's SQLite stores for
 * writing.
 * The SDK itself waits on a held store (busy_timeout, then retries), so a reconcile would only
 * time out; this asks once, without waiting, before recovery or resume write to it.
 */
export async function assertStoreFree(root: string, agentId?: string): Promise<void> {
  // The index, and the agent's own store, which the SDK opens and writes on resume.
  await assertFree(join(root, "index.db"));
  if (agentId) await assertFree(agentStorePath(root, agentId));
}
async function assertFree(index: string): Promise<void> {
  if (!(await exists(index))) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(index, { timeout: 0 });
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/\b(?:locked|busy)\b/i.test(text))
      throw new Error("SQLITE_BUSY: Cursor's saved session is held by another process", {
        cause: error,
      });
    throw error;
  } finally {
    db?.close();
  }
}
