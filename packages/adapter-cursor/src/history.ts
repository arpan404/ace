import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createRedactor } from "@ace/redaction";
import { boundedJson } from "@ace/provider-kit/ipc";
import { checkpointDirectory, checkCheckpointBudget } from "./checkpoints.ts";
import { Limits } from "./contracts.ts";
import type { SdkModule } from "./host-runtime.ts";
import { CursorHost, type HostOptions } from "./host.ts";

export const SnapshotRequest = z.strictObject({
  threadId: z.string().min(1).max(512),
  agentId: z.string().min(1).max(512),
  offset: z.number().int().nonnegative().max(32768).default(0),
  limits: Limits,
});
const Revision = z.string().min(1).max(256);
const Snapshot = z.object({
  agentId: z.string().min(1).max(512),
  revision: Revision,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(200),
  items: z
    .array(
      z
        .object({
          uuid: z.string().max(1024),
          agent_id: z.string().max(512),
          type: z.enum(["user", "assistant"]),
          message: z.unknown(),
        })
        .passthrough(),
    )
    .max(200),
});
async function revision(root: string): Promise<string> {
  const stat = await lstat(join(root, "checkpoints.ndjson"));
  if (!stat.isFile()) throw new Error("SDK checkpoint missing");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
/** Executed in a short-lived memory-limited worker, before Agent.resume can load full history. */
export type SnapshotSdkBoundary = {
  JsonlLocalAgentStore: SdkModule["JsonlLocalAgentStore"];
  Agent: { messages: Pick<SdkModule["Agent"]["messages"], "list"> };
};
export async function snapshotInHost(sdk: SnapshotSdkBoundary, input: unknown, home = homedir()) {
  const request = SnapshotRequest.parse(input);
  if (request.agentId.startsWith("bc-")) throw new Error("Cloud snapshots are forbidden");
  const root = checkpointDirectory(home, request.threadId);
  await checkCheckpointBudget(root, request.limits.maxCheckpointBytes);
  const before = await revision(root);
  const store = new sdk.JsonlLocalAgentStore(root);
  const items = await sdk.Agent.messages.list(request.agentId, {
    runtime: "local",
    store,
    offset: request.offset,
    limit: request.limits.historyPageSize,
  });
  if (before !== (await revision(root)))
    throw new Error("Checkpoint changed during snapshot; reconcile before sending");
  for (const [index, item] of items.entries()) {
    if (
      item.agent_id !== request.agentId ||
      item.uuid !== `${request.agentId}:${request.offset + index}`
    )
      throw new Error("Snapshot position/agent identity mismatch");
  }
  const scrub = createRedactor({ env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } }, ["text"]);
  const safeItems: unknown = JSON.parse(
    scrub(boundedJson(items, Math.min(request.limits.maxFrameBytes - 4096, 262144))),
  );
  return Snapshot.parse({
    agentId: request.agentId,
    revision: before,
    offset: request.offset,
    limit: request.limits.historyPageSize,
    items: safeItems,
  });
}
export async function readCursorSnapshot(
  options: HostOptions,
  input: { threadId: string; agentId: string; offset?: number },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const limits = Limits.parse(options.limits ?? {});
  const host = new CursorHost(options, () => {
    throw new Error("Snapshot workers cannot emit live frames");
  });
  const abort = () => {
    void host.stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const snapshot = Snapshot.parse(
      await host.request("snapshot", { ...input, limits }, limits.timeoutMs),
    );
    signal.throwIfAborted();
    return snapshot;
  } catch {
    throw new Error(
      "Cursor SDK history recovery failed within the checkpoint/heap/time budget. Preserve this thread and create an explicit bounded context handoff; automatic resend is fenced.",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await host.stop();
  }
}
