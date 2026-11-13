import { afterEach, describe, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { ClientOptions } from "@ace/client";
import { ThreadId, type Automation, type Thread, type ThreadStatus } from "@ace/protocol";
import { Sheets } from "./sheets.ts";
import { ThreadSummary, type SummaryReads } from "./thread-summary.ts";
import type { SummaryView } from "./thread-summary-view.ts";
import type { TreeLine } from "./summary-tree.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone's Summary over the real SDK and the in-process fake daemon: the thread and every
 * delegated thread its tree reaches, the turn index and the catch-up, worded by shared code.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

/** 10 000 seconds into 1970, a Thursday: 02:46:40 UTC. */
const now = 10_000_000;

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
  const follow = (reads: SummaryReads = client) => {
    const summary = new ThreadSummary(reads, lease.store, threadId, 1, sink, plainPreview, {
      now: () => now,
      zone: () => "UTC",
      scheduler: timers,
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

/** A daily 9:00 UTC schedule of the person's in `workspace`. */
const nightly = (id: string, workspace: string): Automation => ({
  id,
  title: id,
  enabled: true,
  workspace,
  provider: "claude",
  prompt: "Check for outdated dependencies",
  worktree: true,
  trigger: {
    kind: "schedule",
    schedule: {
      kind: "rrule",
      expression: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "UTC",
      startAt: 0,
    },
  },
  missedRun: "run_once",
  concurrency: 1,
  jitterMs: 0,
});

/** A subagent that ran and finished. */
const finished = (id: string): Fact[] => [
  facts.subagent("codex", id, `Check ${id}`, "spawn"),
  facts.turn(id, "spawn"),
  facts.endTurn(id),
];

/** A tree line as the test reads it: indented, its name or words, live when it breathes. */
const said = (line: TreeLine) =>
  `${"  ".repeat(line.depth)}${line.kind === "agent" ? `${line.name}${line.live ? " (live)" : ""}` : line.kind === "finished" ? line.words : line.command}`;

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
    expect(view(sink)?.agents?.count).toBe(2);
    daemon.apply("now", [facts.endTurn("reviewer")]);
    await until(() => view(sink)?.now.lead === "Done", "tree settled");
    expect(view(sink)?.now.sub).toBe("1 agent finished");
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

  test("the project's schedules close the Summary in one line, and a failed read offers a retry", async () => {
    const { client, sink, follow } = await opened("scheduled", working, {
      details: { workspace: { id: "ace", name: "ace", path: "/code/ace" } },
      before: (fake) =>
        fake.seedServices({
          settings: { "automations.enabled": true },
          automations: [
            nightly("by-id", "ace"),
            nightly("by-folder", "/code/ace"),
            nightly("elsewhere", "relay"),
          ],
        }),
    });
    // The first read fails; the person's retry reads again.
    let fail = true;
    const reads: SummaryReads = {
      thread: (id, options) => client.thread(id, options),
      threadRoom: () => client.threadRoom(),
      turnsPage: (request) => client.turnsPage(request),
      threadCatchUp: (request) => client.threadCatchUp(request),
      threadReadState: (request) => client.threadReadState(request),
      request: ((request, options) =>
        fail && request.type === "automation.list"
          ? Promise.reject(new Error("dropped"))
          : client.request(request, options)) as SummaryReads["request"],
    };
    const summary = follow(reads);
    await until(() => view(sink)?.automations?.failed === true, "the failed read");
    expect(view(sink)?.automations?.line).toBe("Couldn't read automations. Try again");
    fail = false;
    summary.automations();
    await until(() => view(sink)?.automations?.failed === false, "the read again");
    // Only this project's, by its id or its folder; the soonest start said once.
    expect(view(sink)?.automations?.line).toBe(
      "2 automations in this project · next today 9:00 AM · in 6h",
    );
  });

  test("the tree spans delegated threads, live branches open and finished siblings folded", async () => {
    const { sink, follow } = await opened(
      "forest",
      [
        ...working,
        ...finished("a"),
        ...finished("b"),
        ...finished("c"),
        facts.subagent("claude", "live", "Write the docs", "spawn"),
        facts.turn("live", "spawn"),
        ...delegate("kid", "kid", { state: "working", agents: 1 }),
      ],
      {
        before: (fake) =>
          child(fake, "kid", "forest", [
            ...working,
            facts.subagent("codex", "explore", "Explore", "spawn"),
            facts.turn("explore", "spawn"),
          ]),
      },
    );
    const summary = follow();
    const lines = () => view(sink)?.agents?.lines ?? [];
    const named = (name: string) =>
      lines().find((line) => line.kind === "agent" && line.name === name);
    await until(() => named("Explore") !== undefined, "the child's subagent");
    // The child thread's own subagent hangs under its delegate; three finished ones fold.
    expect(lines().map(said)).toEqual([
      "Codex (live)",
      "  Write the docs (live)",
      "  kid (live)",
      "    Explore (live)",
      "  3 done",
    ]);
    const kid = named("kid");
    expect(kid).toMatchObject({
      kind: "agent",
      provider: "codex",
      expanded: true,
      open: { threadId: "forest", agentId: expect.any(String), childThreadId: "kid" },
    });
    // The thread's own main agent opens nothing: it is the tree itself.
    expect(lines()[0]).toMatchObject({ kind: "agent", open: null, depth: 0 });
    const done = lines().find((line) => line.kind === "finished");
    if (done?.kind !== "finished") throw new Error("no done line");
    expect(done.expanded).toBe(false);
    // The person opens the done line: its agents show in place, settled and dimmed.
    summary.fold(done.key, true);
    expect(lines().map(said).slice(-3)).toEqual(["  Check a", "  Check b", "  Check c"]);
    expect(lines().at(-1)).toMatchObject({
      kind: "agent",
      done: true,
      muted: true,
      live: false,
      step: "finished",
    });
    // Folding a live branch hides what it holds and says it on its row.
    summary.fold(kid?.key ?? "", false);
    expect(lines().map(said)).not.toContain("    Explore (live)");
    expect(named("kid")).toMatchObject({
      expanded: false,
      folded: "1 working",
    });
  });

  test("a child on another machine is one row in the tree, stopped through its parent's hold", async () => {
    const remote = "ace-child:remote";
    const { sink, follow } = await opened("holding", [
      ...working,
      {
        type: "agent.seen",
        agent: remote,
        parent: "root",
        origin: "ace",
        fidelity: "summary",
        native: { provider: "claude" },
        cwd: "",
        role: "reviewer",
        machine: { machine: "studio", name: "Studio" },
      },
      {
        type: "agent.external",
        agent: remote,
        threadId: ThreadId.parse("remote"),
        status: { state: "working", agents: 1 },
      },
      {
        type: "background.started",
        owner: "ace",
        agent: "root",
        task: "hold",
        kind: "subagent",
        title: "reviewer · Studio",
        childAgent: remote,
        stoppable: true,
      },
    ]);
    follow();
    await until(() => (view(sink)?.agents?.lines.length ?? 0) === 2, "the tree");
    const [, row] = view(sink)?.agents?.lines ?? [];
    expect(row).toMatchObject({
      kind: "agent",
      machine: "Studio",
      provider: "claude",
      live: true,
      // Its machine's thread isn't here: it opens as its parent's agent.
      open: { threadId: "holding", childThreadId: null },
      stop: { kind: "task", taskId: expect.any(String) },
    });
  });

  test("the thread's sheets open the Summary, and leaving the thread lets it go", async () => {
    const { client, store, sink } = await opened("routed", [
      facts.rootAgent("codex"),
      facts.turn("root"),
    ]);
    const sheets = new Sheets(sink, plainPreview, { now: () => now, scheduler: timers });
    const bare = { owner: client, store, threadId: "routed", epoch: 1 };
    const thread = { ...bare, reads: client };
    // A client that can't read the turn index has no Summary to open.
    expect(sheets.action(bare, { kind: "summary", open: true })).toBe(false);
    expect(sheets.action(thread, { kind: "summary", open: true })).toBe(true);
    await until(() => view(sink)?.now.lead === "Working", "summary opened");
    expect(sheets.action(thread, { kind: "summary.closed", shown: true })).toBe(true);
    expect(sheets.action(thread, { kind: "summary.fold", key: "routed/root", open: false })).toBe(
      true,
    );
    sheets.close();
    expect(view(sink)).toBeUndefined();
    expect(sheets.action(undefined, { kind: "summary", open: false })).toBe(true);
  });
});
