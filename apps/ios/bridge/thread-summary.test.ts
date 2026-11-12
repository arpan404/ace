import { afterEach, describe, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
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

async function opened(threadId: string, seed: Fact[], before?: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: threadId, workspaceId: "ace", title: "Summary", provider: "codex" });
  daemon.apply(threadId, seed);
  before?.(daemon);
  await client.start();
  const lease = client.thread(threadId);
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  const sink = new RecordingSink();
  const cleared = new Map<string, number>();
  const follow = () => {
    const summary = new ThreadSummary(client, lease.store, threadId, 1, sink, plainPreview, {
      now: () => 10_000_000,
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
  return patch.summary as SummaryView;
}

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
    expect(view(sink)?.agents).toBe("2 working");
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
      (fake) => {
        fake.createThread({
          id: "child",
          workspaceId: "ace",
          title: "Docs",
          provider: "codex",
          parentThreadId: "parent",
        });
        fake.apply("child", [facts.rootAgent("codex"), facts.turn("root")]);
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
      (fake) => {
        fake.markReadThrough("away", "first", "ios-sheet-device");
        fake.apply("away", [
          { ...facts.turn("root"), nativeTurnId: "second-turn" },
          facts.message("root", "second", "assistant", "Fixed the login bug."),
          { ...facts.endTurn("root"), nativeTurnId: "second-turn" },
        ] as Fact[]);
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

  test("closing the page stops the summary", async () => {
    const { sink, follow } = await opened("closing", [
      facts.rootAgent("codex"),
      facts.turn("root"),
    ]);
    const summary = follow();
    await until(() => view(sink) !== undefined, "summary");
    summary.close();
    expect(view(sink)).toBeUndefined();
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
