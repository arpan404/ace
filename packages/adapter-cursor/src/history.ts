import { homedir } from "node:os";
import { z } from "zod";
import { createRedactor } from "@ace/redaction";
import { boundedJson } from "@ace/provider-kit/ipc";
import { checkpointDirectory, checkCheckpointBudget } from "./checkpoints.ts";
import { Limits } from "./contracts.ts";
import type { SdkModule } from "./host-runtime.ts";
import { openSdkCheckpointStore, checkpointRevision } from "./sdk-store.ts";
import { CursorHost, type HostOptions } from "./host.ts";

export const SnapshotRequest = z.strictObject({
  threadId: z.string().min(1).max(512),
  agentId: z.string().min(1).max(512),
  offset: z.number().int().nonnegative().max(32768).default(0),
  cwd: z.string().min(1).max(4096).optional(),
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
        })
        .strict(),
    )
    .max(200),
});
/** Executed in a short-lived memory-limited worker, before Agent.resume can load full history. */
export type SnapshotSdkBoundary = {
  JsonlLocalAgentStore: SdkModule["JsonlLocalAgentStore"];
  Agent: {
    messages: {
      list(...args: Parameters<SdkModule["Agent"]["messages"]["list"]>): Promise<unknown>;
    };
  };
};
export async function snapshotInHost(sdk: SnapshotSdkBoundary, input: unknown, home = homedir()) {
  const request = SnapshotRequest.parse(input);
  if (request.agentId.startsWith("bc-")) throw new Error("Cloud snapshots are forbidden");
  const root = checkpointDirectory(home, request.threadId);
  await checkCheckpointBudget(root, request.limits.maxCheckpointBytes);
  const owned = await openSdkCheckpointStore(
    sdk,
    root,
    request.cwd ?? root,
    request.limits.maxCheckpointBytes,
  );
  try {
    const before = await checkpointRevision(owned.store, request.agentId);
    const items = await sdk.Agent.messages.list(request.agentId, {
      runtime: "local",
      store: owned.store,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      offset: request.offset,
      limit: request.limits.historyPageSize,
    });
    if (before !== (await checkpointRevision(owned.store, request.agentId)))
      throw new Error("Checkpoint changed during snapshot; reconcile before sending");
    if (!Array.isArray(items) || items.length > request.limits.historyPageSize)
      throw new Error("Snapshot page exceeds history limit");
    const identities = items.map((item) => {
      const values: Record<string, unknown> = {};
      for (const key of ["uuid", "agent_id", "type"]) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid snapshot identity");
        values[key] = descriptor.value;
      }
      return Snapshot.shape.items.element.parse(values);
    });
    for (const [index, item] of identities.entries()) {
      if (
        item.agent_id !== request.agentId ||
        item.uuid !== `${request.agentId}:${request.offset + index}`
      )
        throw new Error("Snapshot position/agent identity mismatch");
    }
    const scrub = createRedactor({ env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } }, ["text"]);
    const safeItems: unknown = JSON.parse(
      scrub(boundedJson(identities, Math.min(request.limits.maxFrameBytes - 1024, 262144))),
    );
    return Snapshot.parse({
      agentId: request.agentId,
      revision: before,
      offset: request.offset,
      limit: request.limits.historyPageSize,
      items: safeItems,
    });
  } finally {
    await owned.close();
  }
}
export async function readCursorSnapshot(
  options: HostOptions,
  input: { threadId: string; agentId: string; offset?: number; cwd?: string },
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
  } catch (cause) {
    throw new Error(
      "Cursor SDK history could not be verified. Your thread and queued message are preserved; retry after resolving the provider error, or continue with a bounded context handoff.",
      { cause },
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await host.stop();
  }
}
