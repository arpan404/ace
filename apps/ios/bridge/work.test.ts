import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { CommandPayload, ThreadDetails } from "@ace/protocol";
import type { ChangesOwner } from "./changes.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";
import { WorkSession } from "./work.ts";
import { clearStaleLock, workAction } from "./work-actions.ts";
import { followWorkLine } from "./work-line.ts";
import { Sheets } from "./sheets.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const repository = { forge: "github", host: "github.com", owner: "arpan404", name: "ace" } as const;

/** A finished thread on `main` in its local checkout, read by an open Work sheet. */
async function opened(details: Partial<ThreadDetails> = {}, running = false) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({
    id: "work",
    workspaceId: "ace",
    title: "Tidy the queue",
    provider: "codex",
    details: {
      mode: "local",
      branch: "main",
      baseBranch: "main",
      worktree: "/fake/ace",
      head: "c".repeat(40),
      ahead: 0,
      behind: 0,
      repository,
      workspace: { id: "ace", name: "ace", path: "/fake/ace" },
      machine: { host: "mac", name: "Studio" },
      ...details,
    },
  });
  daemon.apply("work", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    ...(running ? [] : [facts.endTurn("root")]),
  ]);
  await client.start();
  const lease = client.thread("work");
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  const sent: CommandPayload[] = [];
  const owner: ChangesOwner = {
    command: (payload) => {
      sent.push(payload);
      return client.command(payload);
    },
    request: client.request.bind(client) as ChangesOwner["request"],
  };
  const sink = new RecordingSink();
  const session = new WorkSession(owner, lease.store, "work", 1, sink, plainPreview);
  await until(() => sink.read("work:summary")?.state === "ready", "checkout read");
  const summary = () => sink.read("work:summary") as Record<string, unknown> & WorkSummary;
  const act = async (action: Record<string, unknown>, id: string) => {
    await workAction(session, action, id, sink, plainPreview);
    return sink.read(`work:result:${id}`);
  };
  return { daemon, owner, session, sink, sent, summary, act, store: lease.store };
}

interface WorkSummary {
  mode: string | null;
  branch: string;
  switchReason: string | null;
  worktreeReason: string | null;
  prs: { number: number; summary: string; owner: string; name: string }[];
  problem: { kind: string; label: string; actions: { id: string; destructive: boolean }[] } | null;
  locked: boolean;
}

describe("Work sheet", () => {
  test("lists the project's branches with the default first, and switches the checkout to one", async () => {
    const { session, sink, summary, act } = await opened();
    await session.branches();
    expect(sink.read("work:branches")).toMatchObject({
      state: "ready",
      names: ["main", "develop"],
    });
    expect(await act({ kind: "switch", branch: "develop" }, "s1")).toMatchObject({
      ok: true,
      message: "Switched to develop",
    });
    await until(() => summary().branch === "develop", "branch switched");
  });

  test("asks before a switch carries uncommitted changes, and sends it again only once told to", async () => {
    const { sent, summary, act } = await opened({ diff: { files: 2, additions: 3, deletions: 1 } });
    const first = await act({ kind: "switch", branch: "develop" }, "s1");
    expect(first).toMatchObject({
      ok: false,
      ask: { confirm: "Switch anyway, bringing changes along" },
    });
    expect(summary().branch).toBe("main");
    expect(
      await act({ kind: "switch", branch: "develop", allowUncommitted: true }, "s2"),
    ).toMatchObject({
      ok: true,
    });
    expect(sent.filter((payload) => payload.type === "thread.workspace.set")).toMatchObject([
      { allowUncommitted: false },
      { allowUncommitted: true },
    ]);
  });

  test("moves the local checkout into a worktree and back", async () => {
    const { summary, act } = await opened();
    expect(await act({ kind: "move", mode: "worktree" }, "m1")).toMatchObject({ ok: true });
    await until(() => summary().mode === "worktree", "in a worktree");
    expect(summary().worktreeReason).toBe("Already in a worktree of its own");
    expect(await act({ kind: "move", mode: "local" }, "m2")).toMatchObject({ ok: true });
    await until(() => summary().mode === "local", "back to local");
  });

  test("never moves the checkout while its agents work, and sends nothing", async () => {
    const { sent, summary, act } = await opened({}, true);
    expect(summary().switchReason).toMatch(/Wait for the agents to stop/);
    expect(await act({ kind: "switch", branch: "develop" }, "s1")).toMatchObject({ ok: false });
    expect(await act({ kind: "move", mode: "worktree" }, "m1")).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  test("shows a failed move with Retry and a confirmed Clear, and clearing it leaves no problem", async () => {
    const { daemon, summary, act } = await opened();
    daemon.workspace.failMoves("git_invalid_ref");
    expect(await act({ kind: "switch", branch: "develop" }, "s1")).toMatchObject({ ok: false });
    await until(() => summary().problem?.kind === "move-failed", "failed move shown");
    expect(summary().problem?.actions).toEqual([
      { id: "retry-move", label: "Retry", destructive: false },
      { id: "clear-move", label: "Clear", destructive: true },
    ]);
    daemon.workspace.failMoves(undefined);
    expect(await act({ kind: "problem", id: "retry-move" }, "r1")).toMatchObject({ ok: true });
    await until(() => summary().branch === "develop" && summary().problem === null, "retried");
    expect(await act({ kind: "problem", id: "clear-move" }, "c1")).toMatchObject({
      ok: false,
      message: "That problem is already resolved.",
    });
  });

  test("retries a failed setup script and lets the held first message go", async () => {
    const { daemon, sent, summary, act } = await opened({
      mode: "worktree",
      worktreeSetup: { state: "failed", details: ["bun install", "error: lockfile"], at: 1 },
    });
    expect(summary().problem).toMatchObject({
      kind: "setup-failed",
      output: ["bun install", "error: lockfile"],
    });
    daemon.holdQueue("work", "not_sent");
    expect(await act({ kind: "problem", id: "setup-retry" }, "p1")).toMatchObject({ ok: true });
    await until(() => summary().problem === null, "setup resolved");
    expect(sent.map((payload) => payload.type)).toEqual(["thread.workspace.setup", "queue.resume"]);
  });

  test("links a pull request by number and by address, and unlinks one of several", async () => {
    const { summary, act } = await opened({ branch: "fix/queue" });
    expect(await act({ kind: "link", reference: "#41" }, "l1")).toMatchObject({
      ok: true,
      message: "Linked #41",
    });
    expect(
      await act({ kind: "link", reference: "https://github.com/arpan404/other/pull/7" }, "l2"),
    ).toMatchObject({ ok: true });
    await until(() => summary().prs.length === 2, "two links");
    expect(
      summary()
        .prs.map((pr) => pr.number)
        .sort(),
    ).toEqual([41, 7].sort());
    expect(
      await act({ kind: "unlink", number: 7, repo: { owner: "arpan404", name: "other" } }, "u1"),
    ).toMatchObject({
      ok: true,
    });
    await until(() => summary().prs.length === 1, "one left");
    expect(summary().prs[0]).toMatchObject({ number: 41, owner: "arpan404", name: "ace" });
  });

  test("refuses a reference that isn't a pull request, without sending anything", async () => {
    const { sent, act } = await opened();
    expect(await act({ kind: "link", reference: "not a pr" }, "l1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("PR number"),
    });
    expect(sent).toEqual([]);
  });

  test("reports a write whose answer never came as unconfirmed, not done", async () => {
    const { session, sink } = await opened();
    const lost: ChangesOwner = {
      command: async () => {
        const { ClientError } = await import("@ace/client");
        throw new ClientError("timeout");
      },
      request: session.owner.request,
    };
    const unanswered = new WorkSession(lost, session.store, "work", 1, sink, plainPreview);
    await workAction(unanswered, { kind: "move", mode: "worktree" }, "m1", sink, plainPreview);
    expect(sink.read("work:result:m1")).toMatchObject({ ok: false, uncertain: true });
    unanswered.close();
  });
});

describe("stale Git lock", () => {
  test("shows the lock a stopped daemon left, and clearing it says it was cleared", async () => {
    const { daemon, owner, sink, summary } = await opened();
    daemon.holdQueue("work", "not_sent", { title: "Git is locked", code: "git_quarantined" });
    await until(() => summary().locked, "lock shown");
    await clearStaleLock(owner, "work", "k1", sink, plainPreview);
    expect(sink.read("work:result:k1")).toMatchObject({
      ok: true,
      message: "Lock cleared. Retry to send it.",
    });
  });
});

describe("problem line in the thread", () => {
  /** The line as the thread screen receives it, read whenever the test looks. */
  function line(store: Parameters<typeof followWorkLine>[0]) {
    let read: () => Record<string, unknown> | undefined = () => undefined;
    const tap = followWorkLine(store, (_key, next) => (read = next), plainPreview);
    return {
      tap,
      row: () => read()?.row as { label: string; actions: { id: string; label: string }[] } | null,
    };
  }

  test("says nothing while the checkout is fine", async () => {
    const { store } = await opened();
    expect(line(store).row()).toBeNull();
  });

  test("offers Retry and Change checkout for a failed move, but keeps Clear in Work", async () => {
    const { daemon, store, act } = await opened();
    const shown = line(store);
    daemon.workspace.failMoves("git_invalid_ref");
    await act({ kind: "switch", branch: "develop" }, "s1");
    await until(() => store.thread?.details?.workspaceChange?.state === "failed", "move failed");
    shown.tap("all");
    expect(shown.row()).toMatchObject({ label: "Checkout move failed" });
    expect(shown.row()?.actions.map((action) => action.label)).toEqual([
      "Retry",
      "Change checkout",
    ]);
  });

  test("offers Clear stale lock when an earlier daemon's lock stopped a message", async () => {
    const { daemon, store } = await opened();
    const shown = line(store);
    daemon.holdQueue("work", "not_sent", { title: "Git is locked", code: "git_quarantined" });
    await until(() => store.queue?.lastFailure?.code === "git_quarantined", "held");
    shown.tap("all");
    expect(shown.row()?.actions).toEqual([
      { id: "lock.clear", label: "Clear stale lock", destructive: true },
    ]);
  });

  test("retries a failed setup from the line while the Work sheet is closed", async () => {
    const { owner, store, summary, sent } = await opened({
      worktreeSetup: { state: "failed", details: ["error: lockfile"], at: 1 },
    });
    expect(summary().problem?.kind).toBe("setup-failed");
    const sink = new RecordingSink();
    const sheets = new Sheets(sink, plainPreview);
    const thread = { owner, store, threadId: "work", epoch: 1 };
    expect(
      sheets.action(thread, {
        kind: "work.action",
        action: { kind: "problem", id: "setup-continue" },
        requestId: "p1",
      }),
    ).toBe(true);
    await until(() => sink.read("work:result:p1") !== undefined, "outcome");
    expect(sink.read("work:result:p1")).toMatchObject({
      ok: true,
      message: "Started without setup",
    });
    expect(sent.map((payload) => payload.type)).toContain("thread.workspace.setup");
  });
});
