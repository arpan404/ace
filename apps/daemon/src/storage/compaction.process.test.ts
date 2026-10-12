import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { Command, DeviceId } from "@ace/protocol";
import { MaintenanceGate } from "@ace/service";
import { stubHandler } from "../commands.ts";
import { startServer } from "../server.ts";
import { Client, token } from "../socket-test-support.ts";
import { storageFixture } from "./test-support.ts";
import type { CompactionRuntime } from "./compaction-process.ts";

function heldWorker(schedule?: CompactionRuntime["schedule"]) {
  const ready = Promise.withResolvers<ChildProcess>();
  let child: ChildProcess | undefined;
  const runtime: CompactionRuntime = {
    ...(schedule ? { schedule } : {}),
    spawn(_url, input) {
      child = spawn(
        process.execPath,
        [join(import.meta.dirname, "compaction-test-worker.ts"), JSON.stringify(input)],
        {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      const processHandle = child;
      child.once("message", (message: unknown) => {
        z.literal("ready").parse(message);
        ready.resolve(processHandle);
      });
      child.once("error", ready.reject);
      child.once("exit", () => ready.reject(new Error("Helper exited before ready")));
      return child;
    },
  };
  return { runtime, ready: ready.promise, kill: () => child?.kill("SIGKILL") };
}

test("the same daemon socket serves heartbeat and SQLite reads while compaction fences writes", async () => {
  const worker = heldWorker();
  const f = await storageFixture(undefined, undefined, worker.runtime);
  const retained = f.thread("retained");
  const server = await startServer({
    port: 0,
    token,
    hostId: "host",
    store: f.store,
    handler: stubHandler({ development: true }),
    storage: f.storage,
  });
  f.storage.bindMaintenance(server.maintenance);
  const client = new Client(server.url);
  try {
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("owner"), token });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    const plan = await f.storage.plan("owner", {
      op: "cleanup.plan",
      kinds: ["logs"],
      forceItems: [],
    });
    client.send({
      type: "storage.request",
      requestId: "compact",
      operation: { op: "cleanup.apply", planId: plan.id, revision: plan.revision, compact: true },
    });
    const child = await worker.ready;
    // The helper cannot complete until these responses have reached the same client.
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.send({
      type: "subscribe",
      subscriptionId: "during-compaction",
      scope: { kind: "thread", threadId: retained.id },
    });
    expect(await client.next()).toMatchObject({
      type: "snapshot",
      subscriptionId: "during-compaction",
    });
    client.send({
      type: "command",
      command: Command.parse({
        id: "during",
        deviceId: "owner",
        payload: {
          type: "thread.create",
          workspaceId: retained.workspaceId,
          provider: "codex",
          title: "Blocked",
          input: [{ type: "text", text: "new work" }],
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "maintenance",
      commandId: "during",
    });
    // HTTP maintenance release cannot override the scoped compaction fence.
    server.maintenance.leave();
    expect(server.maintenance.admit()).toBe(false);
    child.send("compact");
    expect(await client.next()).toMatchObject({
      type: "storage.result",
      requestId: "compact",
      result: { kind: "apply", apply: { state: "complete", compaction: "complete" } },
    });
    client.send({
      type: "command",
      command: Command.parse({
        id: "after",
        deviceId: "owner",
        payload: {
          type: "thread.create",
          workspaceId: retained.workspaceId,
          provider: "codex",
          title: "Allowed",
          input: [{ type: "text", text: "new work" }],
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: true,
      commandId: "after",
    });
    expect(f.store.listThreads().map((thread) => thread.title)).toContain("Allowed");
  } finally {
    worker.kill();
    await client.close();
    await server.close();
    await f.close();
  }
});

test("the compaction deadline kills its owned helper and restores admission after confirmed exit", async () => {
  const deadlines = new Map<number, () => void>();
  const worker = heldWorker((delay, work) => {
    deadlines.set(delay, work);
    return () => deadlines.delete(delay);
  });
  const f = await storageFixture(undefined, undefined, worker.runtime);
  const maintenance = new MaintenanceGate(() => 0);
  f.storage.bindMaintenance(maintenance);
  try {
    const plan = await f.storage.plan("owner", {
      op: "cleanup.plan",
      kinds: ["logs"],
      forceItems: [],
    });
    const applying = f.storage.apply("owner", plan.id, plan.revision, true);
    await worker.ready;
    expect(maintenance.admit()).toBe(false);
    const expire = deadlines.get(30000);
    if (!expire) throw new Error("No bounded compaction deadline");
    expire();
    expect(await applying).toMatchObject({ state: "complete", compaction: "deferred" });
    expect(maintenance.admit()).toBe(true);
    expect(f.thread("after-cancellation").title).toBe("after-cancellation");
  } finally {
    worker.kill();
    await f.close();
  }
});
