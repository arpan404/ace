import "./test-host.ts";
import { expect, test } from "vitest";
import { ComposeSearch, type ComposeSearchOwner } from "./compose-search.ts";
import { pauseOn } from "./market.ts";

class Building extends ComposeSearch {
  readonly asked: string[] = [];
  override async complete(_workspaceId: string, query: string) {
    this.asked.push(query);
    return { paths: [], ready: false };
  }
}

const owner = { onMessage: () => () => {} } as unknown as ComposeSearchOwner;
const sink = { put: () => {} } as never;

test("a newer query ends the older query's wait for the index at once", async () => {
  const signals: AbortSignal[] = [];
  const search = new Building(
    owner,
    sink,
    (path) => path,
    (_ms, signal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  );
  const older = search.mentions("w", "a");
  await Promise.resolve();
  await Promise.resolve();
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
  void search.mentions("w", "ab");
  expect(signals[0]?.aborted).toBe(true);
  await older;
  expect(search.asked).toEqual(["a", "ab"]);
});

test("a pause on an already aborted signal never starts its timer", async () => {
  let started = 0;
  const controller = new AbortController();
  controller.abort();
  await pauseOn(() => {
    started++;
    return () => {};
  })(2_000, controller.signal);
  expect(started).toBe(0);
});

test("a pause that ends on its timer lets go of the abort signal", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  await pauseOn((_ms, callback) => {
    queueMicrotask(callback);
    return () => cancelled++;
  })(2_000, controller.signal);
  controller.abort();
  expect(cancelled).toBe(0);
});
