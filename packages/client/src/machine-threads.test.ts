import { expect, test } from "vitest";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { MachineThreads, machineThreadKey } from "./machines.ts";
import { entry, sidebarBoundary, mergedBoundary } from "./machine-threads.fixture.ts";

function snapshot(ids: string[]) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  for (const id of ids) {
    daemon.createThread({ id, workspaceId: "project", title: id, provider: "codex" });
    daemon.apply(id, [facts.rootAgent("codex")]);
  }
  return daemon.snapshot({ kind: "threads" });
}
const key = (threadId: string, hostId = "laptop") => machineThreadKey({ hostId, threadId });

test("replacement sidebars retain cached facts and counts through delayed and failed snapshots", () => {
  const f = mergedBoundary();
  f.sidebar.snapshot(snapshot(["a", "b"]));
  const count = f.store.count(() => true);
  const values: number[] = [];
  const stop = count.subscribe(() => values.push(count.getSnapshot()));
  const cached = f.store.thread(key("a"));
  const replacement = sidebarBoundary();
  f.store.attach(entry(), replacement.lease);
  expect(f.store.loaded("laptop")).toBe(false);
  expect(f.store.ids).toEqual([key("a"), key("b")]);
  expect(f.store.thread(key("a"))).toBe(cached);
  expect(count.getSnapshot()).toBe(2);
  replacement.fail();
  expect(f.store.thread(key("a"))).toBe(cached);
  expect(count.getSnapshot()).toBe(2);
  expect(values).toEqual([]);
  replacement.snapshot(snapshot(["b", "c"]));
  expect(f.store.loaded("laptop")).toBe(true);
  expect(f.store.ids).toEqual([key("b"), key("c")]);
  expect(f.store.thread(key("a"))).toBeUndefined();
  expect(count.getSnapshot()).toBe(2);
  replacement.snapshot(snapshot([]));
  expect(f.store.ids).toEqual([]);
  expect(count.getSnapshot()).toBe(0);
  stop();
});

test("throwing change and count observers cannot interrupt rows, later observers or keyed selections", () => {
  const f = mergedBoundary();
  const stopThrow = f.store.observeChanges(() => { throw new Error("Consumer failure"); });
  const observed: string[] = [];
  const stopObserve = f.store.observeChanges(({ key }) => observed.push(key));
  const count = f.store.count(() => true);
  const stopCountThrow = count.subscribe(() => { throw new Error("Count consumer failure"); });
  const counts: number[] = [];
  const stopCount = count.subscribe(() => counts.push(count.getSnapshot()));
  const selection = f.store.select([`thread:${key("b")}`], (store) => store.thread(key("b"))?.thread.title);
  const titles: (string | undefined)[] = [];
  const stopSelection = selection.subscribe(() => titles.push(selection.getSnapshot()));
  f.sidebar.snapshot(snapshot(["a", "b"]));
  expect(f.store.ids).toEqual([key("a"), key("b")]);
  expect(f.store.thread(key("a"))?.thread.title).toBe("a");
  expect(f.store.thread(key("b"))?.thread.title).toBe("b");
  expect(observed).toEqual([key("a"), key("b")]);
  expect(count.getSnapshot()).toBe(2);
  expect(counts).toEqual([1, 2]);
  expect(titles).toEqual(["b"]);
  for (const stop of [stopThrow, stopObserve, stopCountThrow, stopCount, stopSelection]) stop();
});

test("loaded snapshots restore the daemon's current order while preserving directory order", () => {
  const f = mergedBoundary();
  const other = sidebarBoundary();
  f.store.attach(entry("server"), other.lease);
  f.sidebar.snapshot(snapshot(["a", "b"]));
  other.snapshot(snapshot(["remote"]));
  const selection = f.store.select(["ids"], (store) => store.ids);
  const orders: (readonly string[])[] = [];
  const stop = selection.subscribe(() => orders.push(selection.getSnapshot()));
  f.sidebar.snapshot(snapshot(["b", "a"]));
  expect(selection.getSnapshot()).toEqual([key("b"), key("a"), key("remote", "server")]);
  expect(orders).toEqual([[key("b"), key("a"), key("remote", "server")]]);
  stop();
});

test.each(["changes", "counts", "mixed"])("%s subscriptions share a bounded admission budget that is released idempotently", (kind) => {
  const store = new MachineThreads();
  const count = store.count(() => true);
  const selected = store.select(["ids"], (merged) => merged.ids);
  const stops: (() => void)[] = [];
  for (let i = 0; i < 4096; i++) {
    const subscribe = kind === "changes" || (kind === "mixed" && i % 3 === 0)
      ? () => store.observeChanges(() => {})
      : kind === "counts" || i % 3 === 1
        ? () => count.subscribe(() => {})
        : () => selected.subscribe(() => {});
    stops.push(subscribe());
  }
  expect(() => store.observeChanges(() => {})).toThrow("limit");
  expect(() => count.subscribe(() => {})).toThrow("limit");
  expect(() => selected.subscribe(() => {})).toThrow("limit");
  const first = stops.shift();
  first?.(); first?.();
  const replacement = count.subscribe(() => {});
  expect(() => count.subscribe(() => {})).toThrow("limit");
  replacement();
  for (const stop of stops) stop();
  const again = store.observeChanges(() => {});
  again();
});
