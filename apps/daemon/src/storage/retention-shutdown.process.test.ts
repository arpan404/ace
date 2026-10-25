import type { StatementSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";
import { StorageService } from "./service.ts";
import type { Store } from "../store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * The store as a multi-gigabyte home presents it: measuring a thread's transcript takes a while
 * per statement. Everything else reads at full speed.
 */
function slowTranscripts(store: Store, milliseconds: number) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const reads = { count: 0 };
  const slow = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "statement") return Reflect.get(target, property, receiver);
      return (sql: string): StatementSync => {
        const statement = target.statement(sql);
        if (!sql.includes("octet_length")) return statement;
        return new Proxy(statement, {
          get(inner, name) {
            if (name !== "get") return Reflect.get(inner, name, inner);
            return (...args: Parameters<StatementSync["get"]>) => {
              reads.count++;
              Atomics.wait(pause, 0, 0, milliseconds);
              return inner.get(...args);
            };
          },
        });
      };
    },
  });
  return { slow, reads };
}

test("stopping during a retention pass over a large history returns at once, and the next run finishes the pass", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  for (let index = 0; index < 40; index++) f.thread(`expired-${index}`);
  const live = f.thread("live-session", { state: "working", agents: 1 }, {});
  const { slow, reads } = slowTranscripts(f.store, 25);
  const owner = { root: f.root, now: f.now, id: () => "plan", store: slow, services: f.services };
  const stopping = new StorageService(owner);
  // A full pass would measure every thread, about 30 seconds here.
  const pass = stopping.retain(120, () => true);
  await expect.poll(() => reads.count).toBeGreaterThan(0);
  const started = performance.now();
  stopping.stop();
  await stopping.close();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await pass).toEqual({ removed: 0, complete: false });
  expect(f.store.getThread(live.id)?.deletedAt).toBeUndefined();
  expect(f.store.getThread("expired-0" as never)?.deletedAt).toBeUndefined();

  // After the restart, retention runs its pass in full and the live session survives it.
  const restarted = new StorageService({ ...owner, store: f.store });
  cleanups.push(() => restarted.close());
  expect(await restarted.retain(120, () => true)).toEqual({ removed: 40, complete: true });
  expect(f.store.getThread(live.id)?.deletedAt).toBeUndefined();
  expect(f.store.getThread("expired-39" as never)?.deletedAt).toBeDefined();
}, 60_000);
