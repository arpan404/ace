import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ServiceContext } from "../../services/types.ts";
import { Store } from "../../store.ts";
import type { TransferArchive, TransferGit } from "../ports.ts";
import { liveSourcePorts } from "./adapters.ts";
import { ThreadOwnership } from "./ownership.ts";
import type { LiveResumes } from "./resumes.ts";

/*
 * The move's read of the tree's children on other machines (ADR 0191), against a real store:
 * which ones still hold the thread here.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** `tree`: the thread's tree here, as the engine reads it; just the thread when absent. */
async function source(tree?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "ace-live-adapters-"));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // No agent control; an engine only to say what the tree is.
  const services = tree ? { engine: { cleanupThreads: () => tree } } : {};
  const context = { store, services, now: () => 1_000 } as unknown as ServiceContext;
  const ports = liveSourcePorts(context, {
    ownership: new ThreadOwnership(store),
    git: {} as TransferGit,
    archive: {} as TransferArchive,
    resumes: {} as LiveResumes,
    sleep: async () => {},
  });
  let next = 0;
  const child = (
    role: string,
    row: { settled?: number; stoppedUnconfirmed?: number; parent?: string },
  ) =>
    store
      .statement(
        `INSERT INTO machine_children (id, request_key, parent_thread, parent_agent, machine, role,
          provider, created_at, settled, settled_at, stopped_unconfirmed)
          VALUES (?, ?, ?, 'a', 'elsewhere', ?, 'claude', 1, ?, ?, ?)`,
      )
      .run(
        `c-${++next}`,
        `k-${next}`,
        row.parent ?? "t",
        role,
        row.settled ?? 0,
        row.settled ? 5 : null,
        row.stoppedUnconfirmed ?? 0,
      );
  return { ports, child, store };
}

/** Looks until every parent's older rows are found, as the move's loop does; how many it took. */
function settle(ports: ReturnType<typeof liveSourcePorts>, threadId: string) {
  for (let looks = 1; looks <= 100; looks++)
    if (ports.remoteChildren(threadId).complete) return looks;
  throw new Error("never complete");
}

it("still counts a child whose stop went unconfirmed in an earlier attempt", async () => {
  const { ports, child } = await source();
  // Settled unconfirmed at 5, long before this attempt; its machine never answered since.
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1 });
  child("gone", { settled: 1, stoppedUnconfirmed: 3 });
  child("answered-late", { settled: 1, stoppedUnconfirmed: 2 });
  expect(ports.remoteChildren("t")).toEqual({
    running: [],
    unconfirmed: ["reviewer", "gone"],
    complete: true,
  });
});

it("finds the unconfirmed child behind many confirmed ones", async () => {
  const { ports, child } = await source();
  for (let index = 0; index < 100; index++) child(`done-${index}`, { settled: 1 });
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1 });
  child("tests", {});
  expect(ports.remoteChildren("t")).toEqual({
    running: ["tests"],
    unconfirmed: ["reviewer"],
    complete: true,
  });
});

it("reads the children of every parent in a large tree", async () => {
  const tree = Array.from({ length: 300 }, (_, index) => `t-${index}`);
  const { ports, child } = await source(tree);
  // Under the 300th thread of the tree, past any one read's parents.
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1, parent: "t-299" });
  child("tests", { parent: "t-280" });
  expect(ports.remoteChildren("t-0")).toEqual({
    running: ["tests"],
    unconfirmed: ["reviewer"],
    complete: true,
  });
});

it("fails the move rather than read part of a tree too large to read whole", async () => {
  const { ports } = await source(Array.from({ length: 5_000 }, (_, index) => `t-${index}`));
  expect(() => ports.remoteChildren("t-0")).toThrow(
    expect.objectContaining({ code: "remote_children_unread" }),
  );
});

it("finds a stop that went unconfirmed long ago behind a long confirmed history, in bounded looks", async () => {
  const { ports, child } = await source();
  // From before the move's table existed: 5,000 confirmed children, then the unconfirmed one.
  for (let index = 0; index < 5_000; index++) child(`done-${index}`, { settled: 1 });
  child("reviewer", { settled: 1, stoppedUnconfirmed: 1 });
  // Not yet all looked through: not taken as clear.
  expect(ports.remoteChildren("t")).toMatchObject({ complete: false });
  expect(settle(ports, "t")).toBeLessThanOrEqual(3);
  expect(ports.remoteChildren("t")).toMatchObject({ unconfirmed: ["reviewer"], complete: true });
});

it("follows stops that go unconfirmed, or are confirmed late, after it started", async () => {
  const { ports, child, store } = await source();
  child("reviewer", { settled: 1 });
  settle(ports, "t");
  const stop = (value: number) =>
    store
      .statement("UPDATE machine_children SET stopped_unconfirmed=? WHERE role='reviewer'")
      .run(value);
  stop(1);
  expect(ports.remoteChildren("t")).toMatchObject({ unconfirmed: ["reviewer"] });
  // Its machine answered late.
  stop(2);
  expect(ports.remoteChildren("t")).toMatchObject({ unconfirmed: [] });
  // A new child that settles unconfirmed, and one lost.
  child("tests", { settled: 1, stoppedUnconfirmed: 3 });
  store.statement("UPDATE machine_children SET lost_at=9 WHERE role='reviewer'").run();
  expect(ports.remoteChildren("t").unconfirmed.toSorted()).toEqual(["reviewer", "tests"]);
});

/** The middle of 15 timings of `run`, in milliseconds. */
function median(run: () => void): number {
  const times = Array.from({ length: 15 }, () => {
    const began = performance.now();
    run();
    return performance.now() - began;
  });
  return times.toSorted((a, b) => a - b)[7] ?? 0;
}

it("reads in time that doesn't grow with a parent's confirmed history", async () => {
  const { ports, child, store } = await source();
  store.atomic(() => {
    for (let index = 0; index < 60_000; index++) child(`done-${index}`, { settled: 1 });
  });
  settle(ports, "t");
  // What reading this parent's settled history once costs, on this machine, now.
  const history = median(() =>
    store
      .statement(
        "SELECT count(*) FROM machine_children WHERE parent_thread='t' AND settled=1 AND stopped_unconfirmed=1",
      )
      .get(),
  );
  const look = median(() => ports.remoteChildren("t"));
  expect(look).toBeLessThan(history / 5);
});

it("fails the move when the children elsewhere can't be read", async () => {
  const { ports, store } = await source();
  store.statement("DROP TABLE machine_children").run();
  expect(() => ports.remoteChildren("t")).toThrow(
    expect.objectContaining({ code: "remote_children_unread" }),
  );
});
