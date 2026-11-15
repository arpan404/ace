// A real daemon, restartable on its port and data directory, and a real client whose kept store
// (read snapshots and host binding) outlives it: the app closed and started again. What crosses
// the socket on the relaunch must be what a short drop sends when the kept copy is complete, and
// the safe full open when it is not resumable.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AdapterRegistry, createDevThread, startDaemon } from "@ace/daemon";
import { AgentId, DeviceId, ItemId, type EventPayload, type ThreadId } from "@ace/protocol";
import { Client } from "./index.ts";
import { memory } from "./read-snapshots.fixture.ts";
import { Faults, ManualScheduler } from "./test-support.ts";
import { screenTail, type Storage } from "./types.ts";

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const root = AgentId.parse("relaunch-root");

/** A real daemon that can be restarted on the same port and data directory, or reset. */
async function restartable() {
  const directory = await mkdtemp(join(tmpdir(), "ace-client-relaunch-"));
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
      // Restarts and reads are what this file tests; probing installed CLIs adds nothing.
      engine: { registry: new AdapterRegistry() },
      modelInstances: [],
    });
  let daemon: Daemon | undefined = await start(0);
  const url = daemon.url;
  const port = Number(new URL(url).port);
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  let workspace = daemon.store.createWorkspace(directory, "test");
  cleanups.push(async () => {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const current = () => {
    if (!daemon) throw new Error("Daemon is stopped");
    return daemon;
  };
  return {
    url,
    token,
    directory,
    current,
    /** A thread with a root agent and `items` replies: past a small tail, under a full one. */
    thread(items: number): ThreadId {
      const store = current().store;
      const thread = createDevThread(store, workspace);
      store.appendEvents(thread.id, [
        {
          type: "agent.created",
          agent: {
            id: root,
            threadId: thread.id,
            parentId: null,
            origin: "root",
            fidelity: "full",
            native: { provider: "codex" },
            cwd: directory,
            status: { state: "idle" },
            createdAt: 1,
            background: false,
          },
        },
      ]);
      for (let index = 0; index < items; index += 20)
        store.appendEvents(
          thread.id,
          Array.from({ length: Math.min(20, items - index) }, (_, n) =>
            reply(`${thread.id}-${index + n}`, `reply ${index + n} `.repeat(40)),
          ),
        );
      return thread.id;
    },
    async restart() {
      await daemon?.close();
      daemon = await start(port);
    },
    /** The same host on a new database: its data is gone, its identity file is not. */
    async reset() {
      await daemon?.close();
      daemon = undefined;
      for (const name of ["events.sqlite", "events.sqlite-wal", "events.sqlite-shm"])
        await rm(join(directory, name), { force: true });
      daemon = await start(port);
      workspace = daemon.store.createWorkspace(directory, "test");
    },
  };
}
const reply = (id: string, text: string): EventPayload => ({
  type: "item.created",
  item: {
    type: "message",
    id: ItemId.parse(id),
    agentId: root,
    role: "assistant",
    createdAt: 1,
    complete: true,
    synthetic: false,
    raw: [],
    parts: [{ type: "text", text }],
  },
});

/**
 * What an app keeps between launches: its read snapshots, outbox and host binding. `readMs`
 * makes each read of a kept record take that long, as a cold store does at launch.
 */
function keptStore(readMs = 0) {
  const snapshots = memory();
  const get = snapshots.storage.get.bind(snapshots.storage);
  snapshots.storage.get = async (key) => {
    if (readMs) await new Promise((resolve) => setTimeout(resolve, readMs));
    return get(key);
  };
  let host: string | null = null;
  let outbox: string | null = null;
  const storage: Storage = {
    load: async () => outbox,
    save: async (value) => {
      outbox = value;
    },
    hostBinding: {
      load: async () => host,
      save: async (value) => {
        host = value;
      },
    },
  };
  return { snapshots, storage };
}

type Wire = { dir: "send" | "recv"; message: Record<string, unknown> };
/** One launch of the app: a client on the kept store, every message it sends and hears logged. */
function launch(
  daemon: Awaited<ReturnType<typeof restartable>>,
  kept: ReturnType<typeof keptStore> | undefined,
  options: { tail?: boolean; holdCompletion?: boolean; welcomeMs?: number } = {},
) {
  const faults = new Faults(daemon.url);
  const wire: Wire[] = [];
  const record = (dir: Wire["dir"], text: string) => {
    const message: unknown = JSON.parse(text);
    if (typeof message === "object" && message !== null)
      wire.push({ dir, message: message as Record<string, unknown> });
  };
  // A slow link: the welcome, and everything behind it, in order, takes its time to come back.
  let late: string[] | undefined;
  faults.incoming = (message, text, deliver) => {
    record("recv", text);
    if (message.type === "welcome" && options.welcomeMs) {
      const queued: string[] = [text];
      late = queued;
      setTimeout(() => {
        late = undefined;
        for (const held of queued) deliver(held);
      }, options.welcomeMs);
    } else if (late) late.push(text);
    else deliver(text);
  };
  let threadSubscribes = 0;
  const held: (() => void)[] = [];
  const transport = () => {
    const inner = faults.create();
    return {
      ...inner,
      send: (text: string) => {
        record("send", text);
        const isThread = text.includes('"type":"subscribe"') && text.includes('"kind":"thread"');
        if (isThread && ++threadSubscribes > 1 && options.holdCompletion)
          held.push(() => inner.send(text));
        else inner.send(text);
      },
    };
  };
  const scheduler = new ManualScheduler();
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("relaunch-device"),
    transport,
    storage: kept?.storage ?? {
      load: async () => null,
      save: async () => {},
    },
    ...(kept ? { readSnapshots: kept.snapshots.storage } : {}),
    ...(options.tail === false ? {} : { openTail: screenTail }),
    credential: async () => daemon.token,
    scheduler,
    random: () => 0.5,
    id: () => `relaunch-${Math.random().toString(36).slice(2)}-${++sequence}`,
  });
  cleanups.push(() => client.close());
  const subscribes = (kind: "thread" | "threads") =>
    wire.filter(
      (entry) =>
        entry.dir === "send" &&
        entry.message.type === "subscribe" &&
        JSON.stringify(entry.message.scope).includes(`"kind":"${kind}"`),
    );
  const answered = (subscriptionId: unknown) =>
    wire.filter((entry) => entry.dir === "recv" && entry.message.subscriptionId === subscriptionId);
  return { client, faults, wire, scheduler, subscribes, answered, held };
}

/** Open the thread and the list; resolve once both are the daemon's, current, and complete. */
async function opened(app: ReturnType<typeof launch>, threadId: ThreadId, head: () => number) {
  const thread = app.client.thread(threadId);
  const list = app.client.threads();
  await app.client.start();
  await vi.waitFor(
    () => {
      const store = thread.store;
      expect(store.cursor).toBe(head());
      expect(store.syncing).toBe(false);
      expect(store.unconfirmed).toBe(false);
      expect(store.filling).toBe(false);
      expect(list.store.loaded && !list.store.syncing && !list.store.unconfirmed).toBe(true);
    },
    { timeout: 8_000 },
  );
  return { thread, list };
}
const shown = (app: ReturnType<typeof launch>, threadId: ThreadId) => {
  const reader = app.client.cachedThread(threadId);
  if (!reader) throw new Error("No thread");
  return {
    thread: reader.thread,
    order: reader.order,
    items: reader.order.map((id) => reader.item(id)),
    itemsBefore: reader.itemsBefore,
    agents: reader.agentIds().map((id) => reader.agent(id)),
  };
};
const listed = (app: ReturnType<typeof launch>) => {
  const store = app.client.threads().store;
  return store.ids.map((id) => store.thread(id));
};
/** What a client opening everything now, with nothing kept, ends with. */
async function fresh(daemon: Awaited<ReturnType<typeof restartable>>, threadId: ThreadId) {
  const app = launch(daemon, undefined, { tail: false });
  await opened(app, threadId, () => daemon.current().store.headSeq());
  return { thread: shown(app, threadId), list: listed(app) };
}

/** A first launch that opens the thread and the list to completion, then closes as on a swipe. */
async function firstLaunch(daemon: Awaited<ReturnType<typeof restartable>>, threadId: ThreadId) {
  const kept = keptStore();
  const app = launch(daemon, kept);
  await opened(app, threadId, () => daemon.current().store.headSeq());
  await app.client.close();
  return kept;
}

test("a relaunch with a kept complete copy resumes the thread from its cursor and the list from its revision", async () => {
  const daemon = await restartable();
  const threadId = daemon.thread(120);
  for (let index = 0; index < 5; index++) daemon.thread(3);
  const kept = await firstLaunch(daemon, threadId);

  const app = launch(daemon, kept);
  await opened(app, threadId, () => daemon.current().store.headSeq());
  const [thread] = app.subscribes("thread");
  // From the cursor, never a tail: the kept copy is complete.
  expect(thread?.message.afterSeq).toEqual(expect.any(Number));
  expect(thread?.message).not.toHaveProperty("tail");
  // Nothing changed: no snapshot of items it holds, only the daemon's confirmation.
  const threadAnswers = app.answered(thread?.message.subscriptionId);
  expect(threadAnswers.map((entry) => entry.message.type)).not.toContain("snapshot");
  expect(app.subscribes("thread")).toHaveLength(1);
  // The list resumes from the revision it kept, and keeps every row it holds.
  const [list] = app.subscribes("threads");
  const window = (list?.message.scope as { window?: { resume?: unknown } } | undefined)?.window;
  expect(window?.resume).toEqual(expect.objectContaining({ revision: expect.any(Number) }));
  const listAnswer = app
    .answered(list?.message.subscriptionId)
    .find((entry) => entry.message.type === "snapshot");
  const view = listAnswer?.message.view as { keep?: string[]; threads?: object } | undefined;
  expect(view?.keep?.length).toBeGreaterThan(0);
  expect(Object.keys(view?.threads ?? {})).toEqual([]);

  const expected = await fresh(daemon, threadId);
  expect(shown(app, threadId)).toEqual(expected.thread);
  expect(listed(app)).toEqual(expected.list);
});

test("a relaunch after the daemon restarted resumes as safely as it can, and ends current", async () => {
  const daemon = await restartable();
  const threadId = daemon.thread(120);
  const kept = await firstLaunch(daemon, threadId);
  await daemon.restart();
  daemon.current().store.appendEvents(threadId, [reply("after-restart", "written after it")]);

  const app = launch(daemon, kept);
  await opened(app, threadId, () => daemon.current().store.headSeq());
  const [thread] = app.subscribes("thread");
  expect(thread?.message.afterSeq).toEqual(expect.any(Number));
  expect(thread?.message).not.toHaveProperty("tail");
  const expected = await fresh(daemon, threadId);
  expect(shown(app, threadId)).toEqual(expected.thread);
  expect(listed(app)).toEqual(expected.list);
});

test("a relaunch on a kept copy from another database replaces it with the daemon's", async () => {
  const daemon = await restartable();
  const threadId = daemon.thread(120);
  const kept = await firstLaunch(daemon, threadId);
  // The same host, a new database: the kept thread is gone, a new one is there.
  await daemon.reset();
  const other = daemon.thread(10);

  const app = launch(daemon, kept);
  const lease = app.client.thread(other);
  const list = app.client.threads();
  await app.client.start();
  await vi.waitFor(
    () => {
      expect(lease.store.cursor).toBe(daemon.current().store.headSeq());
      expect(lease.store.unconfirmed).toBe(false);
      expect(list.store.loaded && !list.store.syncing && !list.store.unconfirmed).toBe(true);
    },
    { timeout: 8_000 },
  );
  // Nothing of the old database's list is shown as the daemon's.
  expect(app.client.threads().store.ids).not.toContain(threadId);
  const expected = await fresh(daemon, other);
  expect(listed(app)).toEqual(expected.list);
  expect(shown(app, other)).toEqual(expected.thread);
});

test("a relaunch on a copy that held only a tail opens the thread afresh", async () => {
  const daemon = await restartable();
  const threadId = daemon.thread(120);
  const kept = keptStore();
  const first = launch(daemon, kept, { holdCompletion: true });
  first.client.thread(threadId);
  await first.client.start();
  await vi.waitFor(() => expect(first.held.length).toBe(1));
  await first.client.close();

  const app = launch(daemon, kept);
  await opened(app, threadId, () => daemon.current().store.headSeq());
  const [thread, completing] = app.subscribes("thread");
  // Nothing was kept of the tail-only copy: a first open, from a tail, completed in full.
  expect(thread?.message).not.toHaveProperty("afterSeq");
  expect(thread?.message.tail).toEqual(screenTail);
  expect(completing?.message).not.toHaveProperty("afterSeq");
  expect(completing?.message).not.toHaveProperty("tail");
  const expected = await fresh(daemon, threadId);
  expect(shown(app, threadId)).toEqual(expected.thread);
});

test("a relaunch whose kept store reads slowly still resumes once the reads are in", async () => {
  const daemon = await restartable();
  const threadId = daemon.thread(120);
  for (let index = 0; index < 5; index++) daemon.thread(3);
  const fast = await firstLaunch(daemon, threadId);
  // The same kept records, now read as a cold store at launch reads them: 400 ms each, on a
  // link whose welcome takes 600 ms to come back.
  const kept = keptStore(400);
  for (const [key, value] of fast.snapshots.values) kept.snapshots.values.set(key, value);
  const binding = fast.storage.hostBinding;
  if (binding) kept.storage.hostBinding = binding;

  const app = launch(daemon, kept, { welcomeMs: 600 });
  const thread = app.client.thread(threadId);
  const list = app.client.threads();
  await app.client.start();
  // A quarter of a second passes before any read is in.
  app.scheduler.advance(300);
  await vi.waitFor(
    () => {
      expect(thread.store.cursor).toBe(daemon.current().store.headSeq());
      expect(thread.store.syncing || thread.store.unconfirmed || thread.store.filling).toBe(false);
      expect(list.store.loaded && !list.store.syncing && !list.store.unconfirmed).toBe(true);
    },
    { timeout: 8_000 },
  );
  const [threadSubscribe] = app.subscribes("thread");
  expect(threadSubscribe?.message.afterSeq).toEqual(expect.any(Number));
  expect(threadSubscribe?.message).not.toHaveProperty("tail");
  const [listSubscribe] = app.subscribes("threads");
  const window = (listSubscribe?.message.scope as { window?: { resume?: unknown } } | undefined)
    ?.window;
  expect(window?.resume).toEqual(expect.objectContaining({ revision: expect.any(Number) }));
  const expected = await fresh(daemon, threadId);
  expect(shown(app, threadId)).toEqual(expected.thread);
  expect(listed(app)).toEqual(expected.list);
});
