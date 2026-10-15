import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDevThread, startDaemon } from "@ace/daemon";
import { DeviceId, type ThreadId } from "@ace/protocol";
import { Client } from "./index.ts";
import { Faults, ManualScheduler, memoryStorage, ready, when } from "./test-support.ts";

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A real daemon that can be restarted on the same port and data directory. */
async function restartable() {
  const directory = await mkdtemp(join(tmpdir(), "ace-client-restart-"));
  const start = (port: number) =>
    startDaemon({
      config: {
        dataDir: directory,
        host: "127.0.0.1",
        port,
        listen: "local",
        remotePort: 0,
        logLevel: "silent",
      },
    });
  let daemon: Daemon | undefined = await start(0);
  const url = daemon.url;
  const port = Number(new URL(url).port);
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(directory, "test"));
  cleanups.push(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    url,
    token,
    thread,
    current: () => {
      if (!daemon) throw new Error("Daemon is stopped");
      return daemon;
    },
    async stop() {
      await daemon?.close();
      daemon = undefined;
    },
    async start() {
      daemon = await start(port);
    },
  };
}

function archives(daemon: Daemon, threadId: ThreadId): number {
  return daemon.store
    .readEvents({ afterSeq: 0, threadId, limit: 1000 })
    .filter(
      (event) => event.payload.type === "thread.updated" && event.payload.archivedAt !== undefined,
    ).length;
}

function connect(url: string, token: string) {
  const faults = new Faults(url);
  const scheduler = new ManualScheduler();
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("restart-device"),
    transport: () => faults.create(),
    storage: memoryStorage(),
    credential: async () => token,
    scheduler,
    random: () => 0.5,
    id: () => `restart-${++sequence}`,
  });
  cleanups.push(() => client.close());
  /** Let the backoff elapse until the client is connected again. */
  const reconnected = async () => {
    for (
      let attempt = 0;
      attempt < 50 && client.connectionState().getSnapshot() !== "ready";
      attempt++
    ) {
      scheduler.advance(30_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await when(client.connectionState(), (state) => state === "ready");
  };
  return { client, faults, reconnected };
}

test("a command the daemon accepted before restarting is acknowledged once after reconnecting", async () => {
  const d = await restartable();
  const { client, faults, reconnected } = connect(d.url, d.token);
  await ready(client);
  // The daemon applies the command, but its result never reaches the client.
  faults.incoming = (message, frame, deliver) => {
    if (message.type !== "commandResult") deliver(frame);
  };
  const id = await client.enqueue(
    { type: "thread.archive", threadId: d.thread.id },
    "archive-before-restart",
  );
  await faults.wait((message) => message.type === "commandResult");
  expect(client.intent(id).getSnapshot()?.state).toBe("pending");
  faults.incoming = (_message, frame, deliver) => deliver(frame);
  await d.stop();
  await d.start();
  await reconnected();
  await when(client.intent(id), (intent) => intent?.state === "acked");
  expect(archives(d.current(), d.thread.id)).toBe(1);
});

test("a command queued while the daemon is down is delivered once when it is back", async () => {
  const d = await restartable();
  const { client, reconnected } = connect(d.url, d.token);
  await ready(client);
  await d.stop();
  await when(client.connectionState(), (state) => state !== "ready");
  const id = await client.enqueue(
    { type: "thread.archive", threadId: d.thread.id },
    "archive-while-down",
  );
  expect(client.intent(id).getSnapshot()?.state).toBe("pending");
  await d.start();
  await reconnected();
  await when(client.intent(id), (intent) => intent?.state === "acked");
  expect(archives(d.current(), d.thread.id)).toBe(1);
});
