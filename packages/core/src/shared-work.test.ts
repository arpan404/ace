import { expect, test } from "vitest";
import { SharedWork } from "./shared-work.ts";

function pending<T>() {
  return Promise.withResolvers<T>();
}

test("waiters for one key share one load and each gets its result", async () => {
  const work = new SharedWork<string>();
  const load = pending<string>();
  let starts = 0;
  const start = () => {
    starts++;
    return load.promise;
  };
  const a = work.join("k", start);
  const b = work.join("k", start);
  load.resolve("patch");
  expect(await Promise.all([a, b])).toEqual(["patch", "patch"]);
  expect(starts).toBe(1);
});

test("a waiter that leaves does not stop the load the others still wait for", async () => {
  const work = new SharedWork<string>();
  const load = pending<string>();
  let loadSignal: AbortSignal | undefined;
  const start = (signal: AbortSignal) => {
    loadSignal = signal;
    return load.promise;
  };
  const leaving = new AbortController();
  const a = work.join("k", start, leaving.signal);
  const b = work.join("k", start);
  leaving.abort();
  await expect(a).rejects.toThrow();
  expect(loadSignal?.aborted).toBe(false);
  load.resolve("patch");
  expect(await b).toBe("patch");
});

test("the load is stopped once every waiter has left, and the next waiter starts a new one", async () => {
  const work = new SharedWork<string>();
  const signals: AbortSignal[] = [];
  const start = (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>(() => {});
  };
  const one = new AbortController();
  const two = new AbortController();
  const a = work.join("k", start, one.signal);
  const b = work.join("k", start, two.signal);
  one.abort();
  two.abort();
  await expect(a).rejects.toThrow();
  await expect(b).rejects.toThrow();
  expect(signals[0]?.aborted).toBe(true);
  void work.join("k", start).catch(() => {});
  expect(signals).toHaveLength(2);
  expect(signals[1]?.aborted).toBe(false);
});

test("start begins a fresh load even while one for the key runs", async () => {
  const work = new SharedWork<number>();
  let n = 0;
  const start = () => Promise.resolve(++n);
  const first = work.join("k", start);
  const fresh = work.start("k", start);
  expect(await first).toBe(1);
  expect(await fresh).toBe(2);
});
