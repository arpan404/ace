import { spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { storageFixture } from "./test-support.ts";
import { StorageService } from "./service.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("stopping during a retention pass over a large history returns at once, and the next run finishes the pass", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  for (let index = 0; index < 3; index++) f.thread(`expired-${index}`);
  const live = f.thread("live-session", { state: "working", agents: 1 }, {});
  const owner = {
    root: f.root,
    now: f.now,
    id: () => "plan",
    store: f.store,
    services: f.services,
  };
  const measuring = Promise.withResolvers<void>();
  const stopping = new StorageService(
    owner,
    {},
    {
      transcripts: {
        spawn() {
          // Stand in for a child stuck in a SQLite read, unable to acknowledge cancellation.
          const worker = spawn(process.execPath, ["-e", 'process.on("message", () => {});'], {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
          worker.once("spawn", measuring.resolve);
          return worker;
        },
      },
    },
  );
  cleanups.push(() => stopping.close());
  const pass = stopping.retain(120, () => true);
  expect(await Promise.race([measuring.promise.then(() => "measuring"), pass])).toBe("measuring");
  const started = performance.now();
  stopping.stop();
  await stopping.close();
  expect(performance.now() - started).toBeLessThan(3000);
  expect(await pass).toEqual({ removed: 0, complete: false });
  expect(f.store.getThread(live.id)?.deletedAt).toBeUndefined();
  expect(f.store.getThread(ThreadId.parse("expired-0"))?.deletedAt).toBeUndefined();

  // After the restart, retention runs its pass in full and the live session survives it.
  const restarted = new StorageService(owner);
  cleanups.push(() => restarted.close());
  expect(await restarted.retain(120, () => true)).toEqual({ removed: 3, complete: true });
  expect(f.store.getThread(live.id)?.deletedAt).toBeUndefined();
  expect(f.store.getThread(ThreadId.parse("expired-2"))?.deletedAt).toBeDefined();
}, 60_000);
