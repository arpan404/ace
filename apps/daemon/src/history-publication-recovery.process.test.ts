import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { openHistory, openArchiveReader } from "@ace/history-import";
import { type ServerMessage, ThreadId, AgentId } from "@ace/protocol";
import { Store } from "./store.ts";
import { DaemonHistory } from "./history.ts";
import { subscribe } from "./subscription.ts";
import { createDevThread } from "./commands.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-publication-recovery-"));
  const data = join(root, "ace");
  const homeDir = join(root, "claude");
  const cwd = "/publication";
  await mkdir(join(homeDir, "projects/p"), { recursive: true });
  await writeFile(
    join(homeDir, "projects/p/saved.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "saved",
      cwd,
      message: { role: "user", content: "saved question" },
    }) + "\n",
  );
  const instances = [{ id: "account", provider: "claude" as const, homeDir }];
  const indexPath = join(data, "history/index.sqlite");
  const service = await openHistory({ indexPath, instances });
  const store = new Store(join(data, "events.sqlite"));
  const workspaceId = store.createWorkspace(cwd, "Publication");
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  const preload = join(root, "exit.mjs");
  let fail: "after" | "before" | undefined = "after";
  let id = 0;
  const history = new DaemonHistory(store, service, data, indexPath, {
    instances,
    now: () => 123,
    nextId: () => `import-${++id}`,
    spawnPublicationWorker(url, options) {
      return new Worker(
        url,
        fail ? { ...options, execArgv: ["--import", pathToFileURL(preload).href] } : options,
      );
    },
  });
  const plain: ServerMessage[] = [];
  const windowed: ServerMessage[] = [];
  const stopPlain = subscribe(store, "plain", { kind: "threads" }, undefined, 100, (message) =>
    plain.push(message),
  );
  const stopWindow = subscribe(
    store,
    "window",
    { kind: "threads", window: { limit: 10, archived: false } },
    undefined,
    100,
    (message) => windowed.push(message),
  );
  return {
    store,
    service,
    source,
    plain,
    windowed,
    workspaceId,
    indexPath,
    databasePath: join(data, "events.sqlite"),
    async fault(boundary: "after" | "before") {
      fail = boundary;
      await writeFile(
        preload,
        boundary === "before"
          ? "process.exit(0);"
          : `
        import { parentPort } from "node:worker_threads";
        const post = parentPort.postMessage.bind(parentPort);
        parentPort.postMessage = (message) => {
          if (message?.ok === true) process.exit(0);
          post(message);
        };
      `,
      );
    },
    restore() {
      fail = undefined;
    },
    import() {
      return history.handle(
        { type: "history.import", sourceId: source.id, workspaceId },
        new AbortController().signal,
      );
    },
    async close() {
      stopPlain();
      stopWindow();
      await history.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a committed import with a lost worker reply reaches both sidebar subscriptions and retries once", async () => {
  const f = await fixture();
  try {
    await f.fault("after");
    const events: number[] = [];
    let createdTail = false;
    const stop = f.store.subscribe((batch) => {
      events.push(...batch.map((event) => event.seq));
      if (
        !createdTail &&
        batch.some(
          (event) => event.payload.type === "thread.created" && event.payload.thread.imported,
        )
      ) {
        createdTail = true;
        createDevThread(f.store, f.workspaceId);
      }
    });
    try {
      expect(await f.import()).toMatchObject({
        type: "history.import",
        status: "imported",
        threadId: "import-1",
      });
      const thread = f.store.importedSource(f.source.id);
      expect(thread?.id).toBe("import-1");
      expect(
        f.plain
          .flatMap((message) => (message.type === "events" ? message.events : []))
          .filter(
            (event) => event.payload.type === "thread.created" && event.threadId === thread?.id,
          ),
      ).toHaveLength(1);
      expect(
        f.windowed.some(
          (message) => message.type === "threads.patch" && "import-1" in message.threads,
        ),
      ).toBe(true);
      const head = f.store.headSeq();
      expect(events).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await f.import()).toMatchObject({ status: "imported", threadId: thread?.id });
      expect(f.store.headSeq()).toBe(head);
      expect(events).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await f.service.findImported(f.source.id)).toBeNull();
    } finally {
      stop();
    }
  } finally {
    await f.close();
  }
});

test("an idempotent import retry finishes publication and removes staging left after commit", async () => {
  const f = await fixture();
  try {
    const threadId = ThreadId.parse("already-committed");
    await f.service.importSession({
      sourceId: f.source.id,
      threadId,
      workspaceId: f.workspaceId,
      agentId: AgentId.parse("root"),
      at: 123,
    });
    // A real independent writer commits while the parent is still alive.
    const writer = new Store(f.databasePath);
    const archive = openArchiveReader(f.indexPath, threadId);
    try {
      writer.installHistory(archive, 123, () => false);
    } finally {
      archive.close();
      await writer.close();
    }
    expect(await f.service.findImported(f.source.id)).not.toBeNull();
    expect(await f.import()).toMatchObject({ status: "imported", threadId });
    expect(
      f.plain
        .flatMap((message) => (message.type === "events" ? message.events : []))
        .filter((event) => event.payload.type === "thread.created" && event.threadId === threadId),
    ).toHaveLength(1);
    expect(
      f.windowed.some((message) => message.type === "threads.patch" && threadId in message.threads),
    ).toBe(true);
    expect(await f.service.findImported(f.source.id)).toBeNull();
    const deliveries = f.plain.length;
    const head = f.store.headSeq();
    await f.import();
    expect(f.store.headSeq()).toBe(head);
    expect(f.plain).toHaveLength(deliveries);
  } finally {
    await f.close();
  }
});

test("a worker exit before commit leaves no phantom publication and its archive can be retried", async () => {
  const f = await fixture();
  try {
    await f.fault("before");
    await expect(f.import()).rejects.toThrow("worker exited");
    expect(f.store.importedSource(f.source.id)).toBeUndefined();
    expect(f.store.headSeq()).toBe(0);
    expect(f.plain.filter((message) => message.type === "events")).toEqual([]);
    expect(f.windowed.filter((message) => message.type === "threads.patch")).toEqual([]);
    expect(await f.service.findImported(f.source.id)).not.toBeNull();
    f.restore();
    expect(await f.import()).toMatchObject({ status: "imported", threadId: "import-1" });
    expect(await f.service.findImported(f.source.id)).toBeNull();
  } finally {
    await f.close();
  }
});
