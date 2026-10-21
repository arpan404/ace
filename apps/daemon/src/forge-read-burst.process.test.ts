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
test("a PR panel's burst of reads all get answered with their own code instead of a refusal, and each failure is logged", async () => {
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
    // Each of these asks GitHub one thing at a time, so running commands count running reads.
    const ops = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? ("forge.pr.merge-state" as const) : ("forge.pr.review-state" as const),
    );
    for (const [index, op] of ops.entries())
      client.send({
        type: "workspace.request",
        requestId: `read-${index}`,
        operation: { op, workspaceId, repository, number: 7 },
      });
    await full;
    release();
    const replies: ServerMessage[] = [];
    for (let index = 0; index < 12; index++) replies.push(await client.next());
    expect(replies.map((reply) => reply.type === "workspace.result" && reply.result)).toEqual(
      Array.from({ length: 12 }, () => ({ kind: "error", code: "forge_offline" })),
    );
    // The burst waited its turn: at most eight reads run from one socket at once, and each
    // read fans out to at most two concurrent calls here (review-state reads its host beside
    // its viewed marks; merge-state reads once), so GitHub never sees more than sixteen.
    expect(peak).toBeLessThanOrEqual(16);
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
});
