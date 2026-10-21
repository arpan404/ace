import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import type { CommandResult } from "@ace/forge";
import { repository } from "@ace/forge/testing";
import { expect, test } from "vitest";
import { stubHandler } from "./commands.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { Client, token } from "./socket-test-support.ts";

// Real socket, SQLite and runtime; only the `gh` CLI is replaced, held until the test lets go.
// The fake counts spawned `gh` commands. A merge-state read is one command;
// a review-state read fetches host and viewed marks concurrently, so spawned
// commands are not a read count. The queue owner (WorkspaceReadQueue) bounds
// logical reads; this helper asserts replies and logs for any burst shape.
async function runBurst(
  ops: ("forge.pr.merge-state" | "forge.pr.review-state")[],
  expectedPeak?: number,
) {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-burst-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  let running = 0;
  let peak = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let saturated!: () => void;
  const full = new Promise<void>((resolve) => (saturated = resolve));
  const runtime = new WorkspaceRuntime(store, join(root, "data"), () => 1000, {
    forgeRunner: () => async (): Promise<CommandResult> => {
      running++;
      peak = Math.max(peak, running);
      if (running === 8) saturated();
      await released;
      running--;
      // GitHub can't be reached: a definite failure with its own code.
      return { code: 1, stdout: "", truncated: false, unreachable: true };
    },
  });
  const warnings: { message: string; fields: object }[] = [];
  const server = await startServer({
    store,
    handler: stubHandler({ development: true }),
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
    warn: (message, fields) => warnings.push({ message, fields }),
  });
  const client = new Client(server.url);
  try {
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    for (const [index, op] of ops.entries())
      client.send({
        type: "workspace.request",
        requestId: `read-${index}`,
        operation: { op, workspaceId, repository, number: 7 },
      });
    await full;
    release();
    const replies: ServerMessage[] = [];
    for (let index = 0; index < ops.length; index++) replies.push(await client.next());
    if (expectedPeak !== undefined) expect(peak).toBe(expectedPeak);
    expect(replies.map((reply) => reply.type === "workspace.result" && reply.result)).toEqual(
      ops.map(() => ({ kind: "error", code: "forge_offline" })),
    );
    // Every request is answered exactly once, in any order: duplicate replies
    // cannot masquerade as a complete burst.
    expect(
      replies
        .map((reply) => (reply.type === "workspace.result" ? reply.requestId : undefined))
        .toSorted(),
    ).toEqual(ops.map((_, index) => `read-${index}`).toSorted());
    const logged = warnings.filter((warning) => warning.message === "Forge read failed");
    expect(logged.map((warning) => warning.fields)).toEqual(
      ops.map(() => expect.objectContaining({ code: "forge_offline" })),
    );
    expect(
      logged.map((warning) => ("op" in warning.fields ? warning.fields.op : undefined)).toSorted(),
    ).toEqual(ops.toSorted());
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("a PR panel's burst of single-command reads waits its turn at eight", async () => {
  // Each merge-state read is one `gh` command, so twelve of them may hold
  // eight command slots, never more, and every one still answers.
  await runBurst(
    Array.from({ length: 12 }, () => "forge.pr.merge-state" as const),
    8,
  );
});

test("a mixed merge/review burst answers every request with its own code", async () => {
  // Review-state reads fetch host and viewed marks concurrently, so spawned
  // commands outnumber logical reads by design. Assert every request is
  // answered and logged under its own op instead of equating the two counts.
  await runBurst(
    Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? ("forge.pr.merge-state" as const) : ("forge.pr.review-state" as const),
    ),
  );
});
