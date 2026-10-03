import { validateLegacyCheckpoint } from "./legacy-checkpoints.ts";
import { access } from "node:fs/promises";
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
  maxBytes = 8_388_608,
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
