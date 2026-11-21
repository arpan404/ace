import { afterEach, describe, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { ClientOptions } from "@ace/client";
import { ThreadId, type Thread, type ThreadStatus } from "@ace/protocol";
import { Sheets } from "./sheets.ts";
import { ThreadSummary } from "./thread-summary.ts";
import type { SummaryView } from "./thread-summary-view.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone's Summary over the real SDK and the in-process fake daemon: the thread and every
 * delegated thread its tree reaches, the turn index and the catch-up, worded by shared code.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const timers = {
  set(delay: number, callback: () => void) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

async function opened(
  threadId: string,
  seed: Fact[],
  setup: {
    before?: (daemon: FakeDaemon) => void;
    details?: Thread["details"];
    limits?: ClientOptions["limits"];
    scheduler?: typeof timers;
    clock?: () => number;
  } = {},
) {
  const { before, details, limits } = setup;
  const { daemon, client } = sheetFixture(limits ? { limits } : {});
  closers.push(() => client.close());
  daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    title: "Summary",
    provider: "codex",
    ...(details ? { details } : {}),
  });
  daemon.apply(threadId, seed);
  before?.(daemon);
  await client.start();
  const lease = client.thread(threadId);
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  const sink = new RecordingSink();
  const cleared = new Map<string, number>();
  const follow = () => {
    const summary = new ThreadSummary(client, lease.store, threadId, 1, sink, plainPreview, {
      now: setup.clock ?? (() => 10_000_000),
      scheduler: setup.scheduler ?? timers,
      cleared,
    });
    closers.push(() => summary.close());
    return summary;
  };
  return { daemon, client, sink, follow, store: lease.store };
}

function view(sink: RecordingSink): SummaryView | undefined {
  const patch = sink.read("thread:summary");
  if (!patch) return undefined;
  expect(patch.type).toBe("thread.summary");
  return patch.sheet as SummaryView;
}

/** An agent of the thread that delegated to `threadId`, its row last told `status`. */
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

/** A delegated thread `id`, started by `parent`, holding `seed`. */
function child(daemon: FakeDaemon, id: string, parent: string, seed: Fact[]) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    parentThreadId: parent,
  });
  daemon.apply(id, seed);
}

const working = [facts.rootAgent("codex"), facts.turn("root")];
const settledWith = (...more: Fact[]) => [...working, ...more, facts.endTurn("root")];

const shell = (agent: string, item: string, command: string, exitCode: number): Fact[] => [
  facts.tool(agent, item, {
    kind: "shell",
    title: command,
    detail: { kind: "shell", command, exitCode },
  }),
  facts.toolDone(agent, item, exitCode === 0 ? "succeeded" : "failed"),
];
const write = (agent: string, item: string, path: string): Fact[] => [
  facts.tool(agent, item, {
    kind: "file.write",
    title: path,
    detail: { kind: "file.write", changes: [{ path, kind: "add", newText: "one\ntwo\n" }] },
  }),
  facts.toolDone(agent, item),
];

const names = (rows: { name: string }[] | undefined) => rows?.map((row) => row.name);

describe("the phone's Summary", () => {
  test("Now says working with the subagent at work, then done once the whole tree settled", async () => {
    const { daemon, sink, follow } = await opened("now", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
      facts.turn("reviewer", "spawn"),
      facts.endTurn("root"),
    ]);
    follow();
    await until(() => view(sink)?.now.sub === "1 agent working", "subagent counted");
    // The main agent's turn ended, but its tree is still at work: never done.
    expect(view(sink)?.now.lead).toBe("Working");
    expect(view(sink)?.agents?.working.map((row) => row.name)).toEqual(["Reviewer"]);
    expect(view(sink)?.now.progress?.words).toBe("0 of 1 done");
    daemon.apply("now", [facts.endTurn("reviewer")]);
    await until(() => view(sink)?.now.lead === "Done", "tree settled");
    expect(view(sink)?.now.sub).toBe("1 agent finished");
  });

  test("the agents read who waits on you first, then working, failed, and the finished folded", async () => {
    const ask = "ask-branch";
    const { sink, follow, store } = await opened("order", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "done1", "Linter", "s1"),
      facts.turn("done1", "spawn"),
      facts.endTurn("done1"),
      facts.subagent("codex", "broke", "Migrator", "s2"),
      facts.turn("broke", "spawn"),
      facts.endTurn("broke", "failed", { kind: "provider", message: "boom" }),
      facts.subagent("codex", "busy", "Tester", "s3"),
      facts.turn("busy", "spawn"),
      facts.subagent("codex", "asker", "Planner", "s4"),
      facts.turn("asker", "spawn"),
      {
        type: "interaction.opened",
        agent: "asker",
        interaction: ask,
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "q",
              text: "Which branch?",
              options: [],
              multiSelect: false,
              allowOther: true,
              secret: false,
            },
          ],
        },
      },
      facts.subagent("codex", "done2", "Docs", "s5"),
      facts.turn("done2", "spawn"),
      facts.endTurn("done2"),
    ]);
    const summary = follow();
    await until(() => (view(sink)?.agents?.asks.length ?? 0) > 0, "asker listed");
    const agents = view(sink)?.agents;
    expect(names(agents?.asks)).toEqual(["Planner"]);
    expect(agents?.asks[0]).toMatchObject({ step: "Asks: Which branch?", action: "Answer" });
    // Answer opens exactly the request the row shows.
    expect(agents?.asks[0]?.requestId).toBe(store.interactionIds()[0]);
    expect(names(agents?.working)).toEqual(["Tester"]);
    expect(names(agents?.failed)).toEqual(["Migrator"]);
    // Finished rows cross only once the person opens their fold.
    expect(agents?.done).toEqual([]);
    expect(agents?.doneWords).toBe("2 done");
    summary.doneRows(true);
    expect(names(view(sink)?.agents?.done)).toEqual(["Linter", "Docs"]);
    expect(view(sink)?.now.progress).toEqual({ done: 2, total: 5, words: "2 of 5 done" });
  });

  test("a row's words follow an item that changes alone, even in a delegated thread", async () => {
    const { daemon, sink, follow } = await opened(
      "steps",
      [...working, ...delegate("lead", "kid")],
      {
        before: (fake) =>
          child(fake, "kid", "steps", [
            facts.rootAgent("codex"),
            facts.turn("root"),
            facts.tool("root", "spawn-worker", {
              kind: "agent.spawn",
              title: "Worker",
              detail: { kind: "agent.spawn", description: "Worker", prompt: "Fix the export." },
            }),
            facts.subagent("codex", "worker", "Worker", "spawn-worker"),
            facts.turn("worker", "spawn"),
            facts.endTurn("worker"),
            // The call ended before its report came: what follows changes that item alone.
            facts.toolDone("root", "spawn-worker"),
          ]),
      },
    );
    const summary = follow();
    summary.doneRows(true);
    const step = () => view(sink)?.agents?.done.find((row) => row.name === "Worker")?.step;
    await until(() => step() === "Finished", "finished without a report yet");
    // The pump reads a patch only when it is put: the change must put the Summary again.
    const puts = sink.puts;
    // Only the spawn call's item changes, with the report: the row says what it came back with.
    daemon.apply("kid", [
      {
        type: "item.upsert",
        agent: "root",
        item: "spawn-worker",
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            status: "succeeded",
            result: {
              isError: false,
              durationMs: 5,
              content: [{ type: "text", text: "Fixed the export." }],
            },
          },
        },
      },
    ]);
    await until(() => sink.puts > puts, "the Summary put again");
    expect(step()).toBe("Fixed the export.");
  });

  test("a counting Now sends only its clock each tick, never the agent list again", async () => {
    let at = Date.now();
    const pending: (() => void)[] = [];
    const scheduler = {
      set(_delay: number, callback: () => void) {
        pending.push(callback);
        return () => {
          const index = pending.indexOf(callback);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    };
    const { sink, follow } = await opened(
      "clock",
      [
        ...working,
        facts.subagent("codex", "helper", "Helper", "s1"),
        facts.turn("helper", "spawn"),
      ],
      { scheduler, clock: () => at },
    );
    follow();
    await until(() => view(sink)?.now.ticking === true, "Now counts");
    const sheets = sink.putsOf.get("thread:summary") ?? 0;
    // A minute on, the tick says the new time without sending the Summary again.
    at += 60_000;
    for (const tick of pending.splice(0)) tick();
    expect(sink.putsOf.get("thread:summary")).toBe(sheets);
    const clock = sink.read("thread:summary.clock");
    expect(clock).toMatchObject({ type: "thread.summary.clock", threadId: "clock" });
    expect(String(clock?.speak)).toMatch(/^working for /);
  });

  test("two hundred agents, the done fold open, still fit one 32 KiB bridge frame", async () => {
    const seed: Fact[] = [...working];
    for (let index = 0; index < 200; index++) {
      const id = `agent-${index}`;
      seed.push(
        facts.subagent("codex", id, `Shard ${index + 1} of the billing export`, `spawn-${id}`, {
          model: "gpt-6.1-sol",
        }),
        facts.turn(id, "spawn"),
      );
      // The first 120 still work; the rest finished.
      if (index >= 120) seed.push(facts.endTurn(id));
    }
    const { sink, follow } = await opened("wide", seed);
    const summary = follow();
    summary.doneRows(true);
    await until(() => view(sink)?.agents?.progress.total === 200, "every agent counted");
    const agents = view(sink)?.agents;
    const shown =
      (agents?.asks.length ?? 0) +
      (agents?.working.length ?? 0) +
      (agents?.failed.length ?? 0) +
      (agents?.done.length ?? 0);
    // What doesn't cross is counted, for the agent tree to show.
    expect(shown + (agents?.hidden ?? 0)).toBe(200);
    expect(agents?.doneWords).toBe("80 done");
    const bytes = new TextEncoder().encode(JSON.stringify(sink.read("thread:summary"))).length;
    expect(bytes).toBeLessThan(32_760);
  });

  test("a delegate stays working while the thread it delegated to still works", async () => {
    const { daemon, sink, follow } = await opened(
      "parent",
      [
        facts.rootAgent("codex"),
        facts.turn("root"),
        {
          type: "agent.seen",
          agent: "delegate",
          parent: "root",
          origin: "ace",
          fidelity: "full",
          native: { provider: "codex", nativeId: "delegate" },
          cwd: "/Users/dev/acme",
          name: "Docs writer",
        },
        // The delegate's own row was last told its thread finished.
        {
          type: "agent.external",
          agent: "delegate",
          threadId: ThreadId.parse("child"),
          status: { state: "done" },
        },
        facts.endTurn("root"),
      ],
      {
        before: (fake) => {
          fake.createThread({
            id: "child",
            workspaceId: "ace",
            title: "Docs",
            provider: "codex",
            parentThreadId: "parent",
          });
          fake.apply("child", [facts.rootAgent("codex"), facts.turn("root")]);
        },
      },
    );
    follow();
    // Read through the child thread's own lease: its main agent is working.
    await until(() => view(sink)?.now.sub.includes("working") === true, "child thread read");
    expect(view(sink)?.now.lead).toBe("Working");
    daemon.apply("child", [facts.endTurn("root")]);
    await until(() => view(sink)?.now.lead === "Done", "child settled");
  });

  test("Results say what the turn changed and how its checks went, in words", async () => {
    const { sink, follow } = await opened("results", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      ...write("root", "w1", "src/app.ts"),
      ...shell("root", "t1", "bun run test", 1),
      ...shell("root", "i1", "git push", 1),
      facts.endTurn("root"),
    ]);
    follow();
    await until(() => view(sink)?.files !== null && view(sink)?.files !== undefined, "turn read");
    expect(view(sink)?.files?.title).toBe("1 file changed");
    expect(view(sink)?.checks).toEqual([{ text: "Tests failed · exit 1", failed: true }]);
    // The failed push isn't a check: it is counted once, apart from the failed tests.
    expect(view(sink)?.commands).toEqual({ ran: "2 commands ran", failed: "1 failed" });
    expect(view(sink)?.now.lead).toBe("Done");
  });

  test("linked pull requests list in review first, with closed ones folded into one line", async () => {
    const repo = { forge: "github", host: "github.com", owner: "acme", name: "app" } as const;
    const linked = (number: number, state: "open" | "closed", checks?: "passed") => ({
      number,
      repo,
      url: `https://github.com/acme/app/pull/${number}`,
      state,
      title: `Change ${number}`,
      updatedAt: number,
      ...(checks ? { checks } : {}),
    });
    const { sink, follow } = await opened(
      "prs",
      [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")],
      { details: { linkedPrs: [linked(7, "closed"), linked(9, "open", "passed")] } },
    );
    const summary = follow();
    await until(() => (view(sink)?.prs.length ?? 0) > 0, "pull requests");
    expect(view(sink)?.prs.map((pr) => `${pr.title}: ${pr.line}`)).toEqual([
      "Change 9: #9 · In review · Checks passed",
    ]);
    expect(view(sink)?.prFold).toBe("1 earlier pull request, closed");
    expect(view(sink)?.workspaceId).toBe("ace");
    summary.closedPrs(true);
    expect(view(sink)?.prs.map((pr) => pr.number)).toEqual([9, 7]);
    expect(view(sink)?.now.sub).toBe("#9 is ready for review");
  });

  test("the plan counts its done items and words each item's state", async () => {
    const { sink, follow } = await opened("plan", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.tool("root", "todo", {
        kind: "todo",
        title: "Plan",
        detail: {
          kind: "todo",
          todos: [
            { content: "Read the spec", status: "completed" },
            { content: "Write the page", status: "in_progress" },
          ],
        },
      }),
    ]);
    follow();
    await until(() => view(sink)?.plan !== null && view(sink)?.plan !== undefined, "plan");
    expect(view(sink)?.plan?.count).toBe("1 of 2");
    expect(view(sink)?.plan?.todos.map((todo) => `${todo.text}: ${todo.words}`)).toEqual([
      "Read the spec: done",
      "Write the page: in progress",
    ]);
  });

  test("since you looked shows what happened after this device's read cursor, until cleared", async () => {
    const { sink, follow } = await opened(
      "away",
      [
        facts.rootAgent("codex"),
        facts.turn("root"),
        facts.message("root", "first", "assistant", "Started."),
        facts.endTurn("root"),
      ],
      {
        before: (fake) => {
          fake.markReadThrough("away", "first", "ios-sheet-device");
          fake.apply("away", [
            { ...facts.turn("root"), nativeTurnId: "second-turn" },
            facts.message("root", "second", "assistant", "Fixed the login bug."),
            { ...facts.endTurn("root"), nativeTurnId: "second-turn" },
          ] as Fact[]);
        },
      },
    );
    const summary = follow();
    await until(() => (view(sink)?.catchUp.length ?? 0) > 0, "catch-up read");
    expect(view(sink)?.catchUp.at(-1)).toEqual({ text: "Fixed the login bug.", tone: "plain" });
    expect(view(sink)?.catchUp[0]?.text).toMatch(/turns? finished/);
    summary.dismiss();
    expect(view(sink)?.catchUp).toEqual([]);
    summary.close();
    // Coming back to the page keeps it cleared for the same cursor.
    follow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view(sink)?.catchUp).toEqual([]);
  });

  test("a delegated thread's own delegate is followed too, while the thread between stays quiet", async () => {
    const { client, sink, follow } = await opened("top", settledWith(...delegate("b", "b")), {
      before: (fake) => {
        child(fake, "b", "top", settledWith(...delegate("c", "c")));
        child(fake, "c", "b", working);
      },
    });
    // Another view on the phone already reads b, so its facts are there when the Summary holds it.
    const b = client.thread("b");
    closers.push(() => b.release());
    await until(() => b.store.agent("c") !== undefined || b.store.agentIds().length > 1, "b read");
    follow();
    await until(() => view(sink)?.now.lead === "Working", "c, two delegations down, read");
  });

  test("a delegated thread refused for room is read once room frees, and again after it gave way", async () => {
    const { client, sink, follow } = await opened("roomy", settledWith(...delegate("kid", "kid")), {
      limits: { threads: 3, threadReserve: 1 },
      before: (fake) => {
        child(fake, "kid", "roomy", working);
        for (const id of ["x", "y"])
          fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
      },
    });
    const room = client.threadRoom();
    const other = client.thread("x", { optional: true });
    expect(room.getSnapshot()).toBe(0);
    follow();
    // No room for kid: its branch can't read done, nor working.
    await until(() => view(sink)?.now.lead === "Syncing", "kid refused");
    other.release();
    await until(() => view(sink)?.now.lead === "Working", "kid read once room freed");
    // The person opens two threads: kid gives its room way, then gets it back when they close.
    const x = client.thread("x");
    const y = client.thread("y");
    await until(() => view(sink)?.now.lead === "Syncing", "kid gave way");
    y.release();
    x.release();
    await until(() => view(sink)?.now.lead === "Working", "kid read again");
  });

  test("closing the page stops the summary and lets every delegated thread go", async () => {
    const { client, sink, follow } = await opened(
      "closing",
      settledWith(...delegate("kid", "kid")),
      {
        limits: { threads: 4, threadReserve: 1 },
        before: (fake) => child(fake, "kid", "closing", working),
      },
    );
    const room = client.threadRoom();
    const spare = room.getSnapshot();
    const summary = follow();
    await until(() => view(sink)?.now.lead === "Working", "kid read");
    expect(room.getSnapshot()).toBe(spare - 1);
    summary.close();
    expect(view(sink)).toBeUndefined();
    expect(room.getSnapshot()).toBe(spare);
  });

  test("the thread's sheets open the Summary, and leaving the thread lets it go", async () => {
    const { client, store, sink } = await opened("routed", [
      facts.rootAgent("codex"),
      facts.turn("root"),
    ]);
    const sheets = new Sheets(sink, plainPreview, { now: () => 10_000_000, scheduler: timers });
    const bare = { owner: client, store, threadId: "routed", epoch: 1 };
    const thread = { ...bare, reads: client };
    // A client that can't read the turn index has no Summary to open.
    expect(sheets.action(bare, { kind: "summary", open: true })).toBe(false);
    expect(sheets.action(thread, { kind: "summary", open: true })).toBe(true);
    await until(() => view(sink)?.now.lead === "Working", "summary opened");
    expect(sheets.action(thread, { kind: "summary.closed", shown: true })).toBe(true);
    sheets.close();
    expect(view(sink)).toBeUndefined();
    expect(sheets.action(undefined, { kind: "summary", open: false })).toBe(true);
  });
});
