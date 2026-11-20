import { expect, test } from "vitest";
import { AcePorts } from "./ace-ports.ts";
import { machinePortWatch, type ListeningScan } from "./port-feed.ts";

function registry(published: (number | undefined)[] = []) {
  const clock = { now: 0 };
  const ace = new AcePorts({ published: () => published, now: () => clock.now });
  return { ace, clock, published };
}

test("a port held in this process is ace's at once, before any scan has run", () => {
  const { ace } = registry();
  const release = ace.hold(7777);
  expect(ace.ownership(7777)).toBe("ace");
  release();
  // Without a scan nothing else is known: not free, but unknown.
  expect(ace.ownership(7777)).toBe("unknown");
});

test("ports are unknown, and so refused, until a scan succeeds and again once it is stale or fails", () => {
  const { ace, clock } = registry();
  expect(ace.ownership(3000)).toBe("unknown");
  ace.scanned(0, new Set([7000]));
  expect(ace.ownership(3000)).toBe("free");
  expect(ace.ownership(7000)).toBe("ace");
  clock.now = ace.staleMs + 1;
  expect(ace.ownership(3000)).toBe("unknown");
  ace.scanned(clock.now, new Set());
  expect(ace.ownership(3000)).toBe("free");
  ace.scanned(clock.now, undefined);
  expect(ace.ownership(3000)).toBe("unknown");
});

test("a port another ace service publishes is ace's whatever the scan says", () => {
  const { ace, published } = registry();
  ace.scanned(0, new Set());
  published.push(4500);
  expect(ace.ownership(4500)).toBe("ace");
});

test("a held port stays ace's until every hold on it is released", () => {
  const { ace } = registry();
  ace.scanned(0, new Set());
  const first = ace.hold(7777);
  const second = ace.hold(7777);
  first();
  first();
  expect(ace.ownership(7777)).toBe("ace");
  second();
  expect(ace.ownership(7777)).toBe("free");
});

test("listeners hear each port that becomes ace's once, however it was learned", () => {
  const { ace } = registry();
  const heard: number[] = [];
  ace.onProtected((port) => heard.push(port));
  ace.hold(7777);
  ace.scanned(0, new Set([7777, 8000]));
  ace.scanned(1, new Set([7777, 8000]));
  // An older scan that finishes late says nothing new.
  ace.scanned(0, new Set([9000]));
  expect(heard).toEqual([7777, 8000]);
  expect(ace.ownership(9000)).toBe("free");
});

function watch(results: (() => Promise<ListeningScan>)[]) {
  const clock = { now: 0 };
  const ace = new AcePorts({ published: () => [], now: () => clock.now });
  let scans = 0;
  const waits: (() => void)[] = [];
  const feed = machinePortWatch({
    scan: () => {
      const next = results[Math.min(scans, results.length - 1)];
      scans++;
      if (!next) throw new Error("No scan result");
      return next();
    },
    acePorts: ace,
    now: () => clock.now,
    wait: (_ms, signal) =>
      new Promise<void>((resolve) => {
        waits.push(resolve);
        signal.addEventListener("abort", () => resolve());
      }),
    limit: 10,
    onError: () => {},
  });
  return { ace, clock, feed, scans: () => scans, tick: () => waits.shift()?.() };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("every connection and every open share one scan of the machine", async () => {
  const scan = { listening: new Set([3000, 7777]), owned: new Set([7777]) };
  const { feed, scans, clock, ace } = watch([async () => scan]);
  const heard: number[][] = [];
  feed.subscribe((ports) => heard.push(ports));
  feed.subscribe((ports) => heard.push(ports));
  await Promise.all([feed.fresh(), feed.fresh(), feed.fresh()]);
  expect(scans()).toBe(1);
  expect(heard).toEqual([[3000], [3000]]);
  expect(ace.ownership(7777)).toBe("ace");
  // Past its age, an open asks for one more, still shared.
  clock.now = ace.scanMs + 1;
  await Promise.all([feed.fresh(), feed.fresh()]);
  expect(scans()).toBe(2);
});

test("a failed scan leaves every unheld port unknown, so opens are refused until one works", async () => {
  let fail = true;
  const { feed, ace } = watch([
    async () => {
      if (fail) throw new Error("lsof failed");
      return { listening: new Set([3000]), owned: new Set() };
    },
  ]);
  await feed.fresh();
  expect(ace.ownership(3000)).toBe("unknown");
  fail = false;
  await feed.fresh();
  expect(ace.ownership(3000)).toBe("free");
});

test("the scan runs only while a connection listens", async () => {
  const { feed, scans, tick } = watch([
    async () => ({ listening: new Set([3000]), owned: new Set() }),
  ]);
  const stop = feed.subscribe(() => {});
  await settle();
  tick();
  await settle();
  expect(scans()).toBe(2);
  stop();
  tick();
  await settle();
  expect(scans()).toBe(2);
});
