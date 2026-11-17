import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interaction, InteractionId, Thread, ThreadId, type WorkspaceId } from "@ace/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Store } from "./store.ts";
import { needsYouSeedSql } from "./needs-you-threads.ts";
import { openRequests, storeRequestSource } from "./services/cli-requests.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-needs-you-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store = new Store(path, console.error);
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return {
    get store() {
      return store;
    },
    workspace,
    reopen() {
      store.close();
      store = new Store(path, console.error);
    },
  };
}

const at = 1_700_000_000_000;

function threadId(n: number): ThreadId {
  return ThreadId.parse(`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`);
}

/** `count` new threads, one transaction: thread `n` was last active at `at + n`. */
function createThreads(store: Store, workspace: WorkspaceId, count: number, from = 0): void {
  const template = Thread.parse({
    id: threadId(0),
    workspaceId: workspace,
    title: "Thread",
    provider: "codex",
    status: { state: "new" },
    createdAt: at,
    updatedAt: at,
  });
  store.atomic(() => {
    for (let n = from; n < from + count; n++) {
      const id = threadId(n);
      store.appendEvents(id, [{ type: "thread.created", thread: { ...template, id } }], at + n);
    }
  });
}

function ask(store: Store, thread: ThreadId, id: string, when: number): void {
  const interaction = Interaction.parse({
    id,
    threadId: thread,
    agentId: "root",
    state: "pending",
    createdAt: when,
    blocking: true,
    request: { kind: "approval", title: "Run the tests?", options: [] },
  });
  // The daemon derives the thread's status from its interactions and stores it alongside.
  store.appendEvents(
    thread,
    [
      { type: "interaction.opened", interaction },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ],
    when,
  );
}

function answer(store: Store, thread: ThreadId, id: string, when: number): void {
  store.appendEvents(
    thread,
    [
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse(id),
        state: "resolved",
        closedAt: when,
      },
      { type: "thread.updated", status: { state: "done" } },
    ],
    when,
  );
}

function list(store: Store) {
  return openRequests(storeRequestSource({ store, services: {} }), { canRead: () => true });
}

describe("threads waiting on a person", () => {
  test("request.list stays fast with a large thread table", () => {
    const f = setup();
    createThreads(f.store, f.workspace, 10_000);
    const waiting = [threadId(17), threadId(5_001), threadId(9_998)];
    waiting.forEach((id, n) => ask(f.store, id, `ask_${n}`, at + 20_000 + n));
    f.reopen();
    const store = f.store;
    // The first list fills the set from the live threads only, through their partial index.
    const plan = store
      .statement(`EXPLAIN QUERY PLAN ${needsYouSeedSql}`)
      .all()
      .map((row) => String(row.detail));
    expect(plan.join("\n")).toMatch(/USING (COVERING )?INDEX/);
    expect(list(store).requests.map((each) => each.interaction.id)).toEqual([
      "ask_0",
      "ask_1",
      "ask_2",
    ]);

    const statements = vi.spyOn(store, "statement");
    const source = storeRequestSource({ store, services: {} });
    const asked: ThreadId[] = [];
    const started = performance.now();
    const result = openRequests(
      {
        ...source,
        thread: (id) => {
          asked.push(id);
          return source.thread(id);
        },
      },
      { canRead: () => true },
    );
    const elapsed = performance.now() - started;
    expect(result.requests.map((each) => each.threadId)).toEqual(waiting);
    expect(asked.toSorted()).toEqual(waiting.toSorted());
    // No statement looks threads up by state: the work follows the open threads, not the table.
    const sql = statements.mock.calls.map(([text]) => text);
    expect(sql.filter((text) => /\$\.state/.test(text))).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("a thread joins when it starts waiting and leaves when answered or deleted", () => {
    const f = setup();
    createThreads(f.store, f.workspace, 3);
    const [first, second, third] = [threadId(0), threadId(1), threadId(2)];
    const waiting = () => f.store.needsYou.list(100);
    expect(waiting()).toEqual([]);

    ask(f.store, first, "ask_first", at + 10);
    ask(f.store, second, "ask_second", at + 20);
    ask(f.store, third, "ask_third", at + 30);
    // Most recent activity first.
    expect(waiting()).toEqual([third, second, first]);

    answer(f.store, first, "ask_first", at + 40);
    expect(waiting()).toEqual([third, second]);

    f.store.appendEvents(
      second,
      [{ type: "thread.client.updated", changes: { deletedAt: at + 50 } }],
      at + 50,
    );
    expect(waiting()).toEqual([third]);
    expect(list(f.store).requests.map((each) => each.interaction.id)).toEqual(["ask_third"]);

    f.store.deleteThread(third);
    expect(waiting()).toEqual([]);
  });

  test("the waiting threads are the same after the store reopens", () => {
    const f = setup();
    createThreads(f.store, f.workspace, 3);
    const [first, second, third] = [threadId(0), threadId(1), threadId(2)];
    ask(f.store, first, "ask_first", at + 10);
    ask(f.store, second, "ask_second", at + 20);
    ask(f.store, third, "ask_third", at + 30);
    answer(f.store, second, "ask_second", at + 40);
    expect(f.store.needsYou.list(100)).toEqual([third, first]);

    f.reopen();
    expect(f.store.needsYou.list(100)).toEqual([third, first]);
    answer(f.store, third, "ask_third", at + 50);
    expect(f.store.needsYou.list(100)).toEqual([first]);
  });

  test("a rolled-back write leaves the set as the rows are", () => {
    const f = setup();
    createThreads(f.store, f.workspace, 1);
    const first = threadId(0);
    expect(f.store.needsYou.list(100)).toEqual([]);
    expect(() =>
      f.store.atomic(() => {
        ask(f.store, first, "ask_first", at + 10);
        expect(f.store.needsYou.list(100)).toEqual([first]);
        throw new Error("rejected");
      }),
    ).toThrow("rejected");
    expect(f.store.needsYou.list(100)).toEqual([]);
  });
});
