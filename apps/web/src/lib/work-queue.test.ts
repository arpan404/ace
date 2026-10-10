import { expect, test } from "vitest";
import { WorkQueue } from "./work-queue.ts";

test("shared leases receive one result and a departing consumer cannot cancel the other", async () => {
  const gate = Promise.withResolvers<string>();
  const queue = new WorkQueue(() => gate.promise, { jobs: 2, bytes: 10 });
  const first = queue.acquire("same", "first", 5);
  const second = queue.acquire("same", "second", 5);
  first.release();
  gate.resolve("complete");
  expect(await second.result).toBe("complete");
  expect(await first.result).toBe("complete");
});

test("obsolete queued jobs disappear and admission recovers after cancellation", async () => {
  const gate = Promise.withResolvers<string>();
  const queue = new WorkQueue(
    (input: string) => (input === "active" ? gate.promise : Promise.resolve(input)),
    { jobs: 2, bytes: 10 },
  );
  const active = queue.acquire("active", "active", 5);
  const stale = queue.acquire("stale", "stale", 5);
  expect(await queue.acquire("full", "full", 1).result).toBeUndefined();
  stale.release();
  expect(await stale.result).toBeUndefined();
  const next = queue.acquire("next", "current", 5);
  gate.resolve("complete");
  expect(await active.result).toBe("complete");
  expect(await next.result).toBe("current");
});

test("leaving the last active lease cancels I/O and allows the next job to finish", async () => {
  const started = Promise.withResolvers<void>();
  const queue = new WorkQueue(
    (input: string, signal) =>
      input === "first"
        ? new Promise<string>((_resolve, reject) => {
            started.resolve();
            signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          })
        : Promise.resolve(input),
    { jobs: 2, bytes: 10 },
  );
  const first = queue.acquire("first", "first", 5);
  const second = queue.acquire("second", "second", 5);
  await started.promise;
  first.release();
  expect(await first.result).toBeUndefined();
  expect(await second.result).toBe("second");
});

test("reopening a running job starts a fresh lease after obsolete work settles", async () => {
  const gate = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const queue = new WorkQueue(
    (input: string) => {
      if (input === "old") {
        started.resolve();
        return gate.promise;
      }
      return Promise.resolve(input);
    },
    { jobs: 2, bytes: 10 },
  );
  const old = queue.acquire("same", "old", 5);
  await started.promise;
  old.release();
  const fresh = queue.acquire("same", "fresh", 5);
  gate.resolve("obsolete");
  expect(await old.result).toBeUndefined();
  expect(await fresh.result).toBe("fresh");
});
