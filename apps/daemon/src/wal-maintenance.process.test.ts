import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import type { CheckpointWorker } from "./wal-worker-runtime.ts";
import type { ThreadId } from "@ace/protocol";

/** Every store delay at 1/50 speed: checkpoints every 20 ms, truncation after 100 ms quiet. */
const fast = {
  delay(callback: () => void, ms: number) {
    const timer = setTimeout(callback, Math.max(1, ms / 50));
    return () => clearTimeout(timer);
  },
};
const walBytes = (path: string) =>
  stat(`${path}-wal`).then(
    (file) => file.size,
    () => 0,
  );
async function until(check: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
function writeRows(store: Store, count: number, prefix: string) {
  const thread = createDevThread(store, store.createWorkspace(`/${prefix}`, prefix));
  const after = store.headSeq();
  for (let index = 0; index < count; index++)
    store.appendEvents(thread.id, [
      { type: "item.created", item: message(`${prefix}-${index}`, "x".repeat(64 * 1024)) },
    ]);
  return after;
}

test("commits leave checkpoints to the worker, which empties the WAL once writes go quiet", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-wal-worker-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path, console.error, { bufferScheduler: fast });
  try {
    const after = writeRows(store, 64, "busy");
    // 4 MB in 64 commits, none of which paid for a checkpoint.
    expect(await walBytes(path)).toBeGreaterThan(3 * 1024 * 1024);
    await until(async () => (await walBytes(path)) === 0, "the worker to truncate the WAL");
    expect(store.readEvents({ afterSeq: after, limit: 100 })).toHaveLength(64);
  } finally {
    await store.close();
  }
  const reopened = new Store(path);
  try {
    expect(reopened.readEvents({ afterSeq: 0, limit: 1000 }).length).toBeGreaterThanOrEqual(64);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** A worker that crashes on its first request, as one whose bundle file is missing would. */
function brokenWorker(): CheckpointWorker {
  const worker = new EventEmitter() as EventEmitter & CheckpointWorker;
  worker.postMessage = () => {
    queueMicrotask(() => worker.emit("error", new Error("worker crashed")));
  };
  worker.terminate = async () => 1;
  return worker;
}

test("a failed checkpoint worker hands checkpoints back to the store, so the WAL stays bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-wal-fallback-"));
  const path = join(root, "events.sqlite");
  const errors: unknown[] = [];
  const store = new Store(path, (error) => errors.push(error), {
    bufferScheduler: fast,
    checkpointWorker: brokenWorker,
  });
  try {
    writeRows(store, 32, "fallback");
    await until(async () => (await walBytes(path)) === 0, "the store to truncate the WAL");
    // One report for the outage, not one per checkpoint.
    expect(errors.filter((error) => String(error).includes("worker crashed"))).toHaveLength(1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing the store leaves an empty WAL while the checkpoint worker holds a connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-wal-close-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path, console.error, { bufferScheduler: fast });
  const after = writeRows(store, 16, "first");
  // Only a worker checkpoint grows the database file: its connection is open from here on.
  await until(async () => (await stat(path)).size > 1024 * 1024, "a worker checkpoint");
  writeRows(store, 16, "second");
  await store.close();
  try {
    expect(await walBytes(path)).toBe(0);
    const reopened = new Store(path);
    try {
      const rows = reopened.readEvents({ afterSeq: after, limit: 1000 });
      expect(rows.filter((event) => event.payload.type === "item.created")).toHaveLength(32);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rows committed before a crash survive it even though no checkpoint ran", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-wal-crash-"));
  const path = join(root, "events.sqlite");
  const script = join(root, "crash.ts");
  const store = pathToFileURL(join(import.meta.dirname, "store.ts")).href;
  const commands = pathToFileURL(join(import.meta.dirname, "commands.ts")).href;
  await writeFile(
    script,
    `import { Store } from ${JSON.stringify(store)};
    import { createDevThread } from ${JSON.stringify(commands)};
    const store = new Store(${JSON.stringify(path)});
    const thread = createDevThread(store, store.createWorkspace("/crash", "Crash"));
    for (let i = 0; i < 40; i++)
      store.appendEvents(thread.id, [{ type: "thread.updated", title: "title " + i }]);
    process.stdout.write(JSON.stringify({ head: store.headSeq(), thread: thread.id }));
    process.kill(process.pid, "SIGKILL");`,
  );
  try {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let acknowledged = "";
    child.stdout.on("data", (chunk: Buffer) => (acknowledged += chunk.toString()));
    const [, signal] = await once(child, "exit");
    expect(signal).toBe("SIGKILL");
    // The crash left the WAL in place: nothing had checkpointed it.
    expect(await walBytes(path)).toBeGreaterThan(0);
    const { head, thread } = JSON.parse(acknowledged) as { head: number; thread: ThreadId };
    const reopened = new Store(path);
    try {
      expect(reopened.headSeq()).toBe(head);
      expect(reopened.getThread(thread)?.title).toBe("title 39");
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
