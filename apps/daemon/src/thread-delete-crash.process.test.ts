import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { z } from "zod";
import { expect, test } from "vitest";
import { Command, DeviceId, ThreadId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import { Engine } from "./engine/index.ts";
import { Store } from "./store.ts";
import { Client, token } from "./socket-test-support.ts";
import { startServer } from "./server.ts";

test("SIGKILL during force cleanup resumes from the same SQLite journal on daemon restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-delete-crash-"));
  const worker = spawnSupervised({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./testing/thread-delete-worker.ts", import.meta.url)),
      home,
      token,
    ],
    env: {},
    name: "delete-fixture",
  });
  const ready = Promise.withResolvers<string>();
  const closing = Promise.withResolvers<void>();
  const Frame = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready"), url: z.string() }),
    z.object({ type: z.literal("closing") }),
  ]);
  let stderr = "";
  worker.stderr.on("line", (line) => {
    stderr = (stderr + line).slice(-4096);
  });
  worker.stdout.on("line", (line) => {
    const frame = Frame.parse(JSON.parse(line));
    if (frame.type === "ready") ready.resolve(frame.url);
    else closing.resolve();
  });
  void worker.exited.then(() => {
    ready.reject(new Error(`Fixture exited: ${stderr}`));
  });
  let client: Client | undefined;
  let store: Store | undefined;
  let engine: Engine | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const command = Command.parse({
    id: "force-crash",
    deviceId: "device",
    payload: { type: "thread.delete", threadId: "crash-thread", force: true },
  });
  try {
    client = new Client(await ready.promise);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, token, deviceId: DeviceId.parse("device") });
    await client.next();
    client.send({ type: "command", command });
    await closing.promise;
    if (!worker.pid) throw new Error("Missing fixture PID");
    process.kill(worker.pid, "SIGKILL");
    await worker.exited;
    await client.close();
    store = new Store(join(home, "events.sqlite"));
    engine = new Engine(store);
    await engine.ready();
    expect(store.getThread(ThreadId.parse("crash-thread"))?.deletedAt).toBeUndefined();
    server = await startServer({
      store,
      engine,
      handler: engine.handler,
      token,
      hostId: "restart",
      port: 0,
    });
    expect(store.getThread(ThreadId.parse("crash-thread"))?.deletedAt).toBeDefined();
    client = new Client(server.url);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, token, deviceId: DeviceId.parse("device") });
    await client.next();
    client.send({ type: "command", command });
    expect(await client.next()).toMatchObject({ ok: true, threadId: "crash-thread" });
    expect(engine.queue(ThreadId.parse("crash-thread")).messages).toEqual([]);
  } finally {
    await worker.stop({ graceMs: 0 });
    await client?.close();
    await server?.close();
    await engine?.close();
    await store?.close();
    await rm(home, { recursive: true, force: true });
  }
});
