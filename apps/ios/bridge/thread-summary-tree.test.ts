import { afterEach, describe, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId, type ThreadStatus } from "@ace/protocol";
import { ThreadSummary, type SummaryReads } from "./thread-summary.ts";
import type { SummaryView } from "./thread-summary-view.ts";
import { forgetTree, type TreeKeep } from "./thread-summary-tree.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The Summary's kept delegates over the real SDK and the fake daemon: a second visit to a busy
 * thread reads no settled delegate's thread again, and a kept entry never outlives a change.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** Timers that run soon, so a visit's keeps and turn reads don't wait their real periods. */
const timers = {
  set(delay: number, callback: () => void) {
    const timer = setTimeout(callback, Math.min(delay, 20));
    return () => clearTimeout(timer);
  },
};

/** An in-memory keep, shared across visits like the phone's snapshot store. */
function memoryKeep(): TreeKeep & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: async (key, value) => void rows.set(key, structuredClone(value)),
    delete: async (key) => void rows.delete(key),
  };
}

const delegate = (agent: string, threadId: string, status: ThreadStatus = { state: "done" }) =>
  [
    {
      type: "agent.seen",
      agent,
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "codex", nativeId: agent },
      cwd: "/Users/dev/acme",
      name: agent,
    },
    { type: "agent.external", agent, threadId: ThreadId.parse(threadId), status },
  ] satisfies Fact[];

function child(daemon: FakeDaemon, id: string, parent: string, settled: boolean) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    parentThreadId: parent,
  });
  daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    ...(settled ? [facts.endTurn("root")] : []),
  ]);
}

const PARENT = "busy";

async function setup(children: number, working: readonly number[] = []) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: PARENT, workspaceId: "ace", title: "Busy", provider: "codex" });
  const seed: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
  for (let index = 0; index < children; index++) {
    const id = `kid-${index}`;
    child(daemon, id, PARENT, !working.includes(index));
    seed.push(
      ...delegate(
        `a${index}`,
        id,
        working.includes(index) ? { state: "working", agents: 1 } : { state: "done" },
      ),
    );
  }
  daemon.apply(PARENT, seed);
  await client.start();
  const keep = memoryKeep();
  /** One visit: a Summary over the client, counting the delegate threads it reads. */
  const visit = async () => {
    const lease = client.thread(PARENT);
    await until(() => lease.store.thread !== undefined, "thread snapshot");
    const read: string[] = [];
    const reads: SummaryReads = {
      thread: (id, options) => {
        read.push(id);
        return client.thread(id, options);
      },
      threadRoom: () => client.threadRoom(),
      threads: () => client.threads(),
      turnsPage: (request) => client.turnsPage(request),
      threadCatchUp: (request) => client.threadCatchUp(request),
      threadReadState: (request) => client.threadReadState(request),
    };
    const sink = new RecordingSink();
    const summary = new ThreadSummary(reads, lease.store, PARENT, 1, sink, plainPreview, {
      now: () => 10_000_000,
      scheduler: timers,
      cleared: new Map(),
      tree: keep,
    });
    const view = () => sink.read("thread:summary")?.sheet as SummaryView | undefined;
    return { summary, view, read, lease };
  };
  return { daemon, client, keep, visit };
}

describe("the Summary's kept delegates", () => {
  test("a second visit to a 200-delegate thread reads no settled delegate and shows them at once", async () => {
    const { keep, visit } = await setup(200);
    const first = await visit();
    await until(() => first.view()?.agents?.doneWords === "200 done", "first visit settled");
    expect(first.read.length).toBe(200);
    first.summary.close();
    first.lease.release();
    expect(keep.rows.size).toBe(1);

    const second = await visit();
    await until(() => second.view()?.agents?.doneWords === "200 done", "second visit shown");
    expect(second.read).toEqual([]);
    second.summary.close();
  }, 30_000);

  test("a delegate that settled while the thread was closed shows settled, the settled ones stay kept", async () => {
    const { daemon, visit } = await setup(20, [3]);
    const first = await visit();
    await until(() => first.view()?.agents?.doneWords === "19 done", "first visit");
    expect(first.view()?.agents?.working).toHaveLength(1);
    first.summary.close();
    first.lease.release();

    daemon.apply("kid-3", [facts.endTurn("root")]);
    const second = await visit();
    await until(() => second.view()?.agents?.doneWords === "20 done", "settled on reopen");
    expect(second.view()?.agents?.working).toEqual([]);
    // Only the delegate that was working is read again.
    expect(second.read).toEqual(["kid-3"]);
    second.summary.close();
  });

  test("a delegate touched after it was kept is read again, never shown from the kept copy", async () => {
    const { daemon, visit } = await setup(5);
    const first = await visit();
    await until(() => first.view()?.agents?.doneWords === "5 done", "first visit");
    first.summary.close();
    first.lease.release();

    daemon.apply("kid-2", [
      { type: "turn.started", agent: "root", nativeTurnId: "root-turn-2", trigger: "user" },
    ]);
    const second = await visit();
    await until(() => second.view()?.agents?.working.length === 1, "working again");
    expect(second.read).toEqual(["kid-2"]);
    expect(second.view()?.agents?.doneWords).toBe("4 done");
    second.summary.close();
  });

  test("forgetting a thread drops its kept delegates", async () => {
    const { keep, visit } = await setup(3);
    const first = await visit();
    await until(() => first.view()?.agents?.doneWords === "3 done", "first visit");
    first.summary.close();
    expect(keep.rows.size).toBe(1);
    await forgetTree(keep, PARENT);
    expect(keep.rows.size).toBe(0);
    const second = await visit();
    await until(() => second.view()?.agents?.doneWords === "3 done", "read live again");
    expect(second.read.length).toBe(3);
    second.summary.close();
  });
});
