import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

/**
 * The work commands against a real daemon on a temp home (ADR 0176 §7, §8, §9): old spellings
 * reach the same daemon operation as the new ones, `request answer` resolves a question, and
 * nothing prompts without a terminal. Scripted providers only; HOME is an empty temp folder.
 */
type Fixture = Awaited<ReturnType<typeof daemonFixture>>;

const emptyHome = mkdtempSync(join(tmpdir(), "ace-cli-work-home-"));
afterAll(() => rmSync(emptyHome, { recursive: true, force: true }));

function cli(f: Fixture, args: string[], stdin = "") {
  return invoke(join(f.h.home, "daemon"), args, stdin, { HOME: emptyHome, ACE_NO_INPUT: "" });
}

async function spawn(f: Fixture, name: string) {
  const result = await f.call({
    op: "delegate_task",
    requestId: name,
    provider: "claude",
    task: `Do ${name}`,
    role: `do-${name}`,
    wait: false,
    estimatedLoad: 0,
  });
  await f.daemon.engine?.flush();
  return z.object({ threadId: ThreadId }).parse(result.data).threadId;
}

async function emit(f: Fixture, thread: ThreadId, ...facts: Fact[]) {
  const context = f.h.contexts.get(thread);
  if (!context) throw new Error("Missing native session");
  context.onFrame(f.h.frames.frame(...facts));
  await f.daemon.engine?.flush();
}

const approval = (id: string): Fact => ({
  type: "interaction.opened",
  agent: "root",
  interaction: id,
  blocking: true,
  request: {
    kind: "approval",
    title: `Synthetic ${id}`,
    options: [
      { id: "yes", label: "Allow once", kind: "allow_once" },
      { id: "no", label: "Deny", kind: "deny" },
    ],
  },
});

const requestList = z.object({
  requests: z.array(z.object({ threadId: z.string(), interaction: z.object({ id: z.string() }) })),
});

async function openRequests(f: Fixture, thread?: string) {
  const listed = await cli(f, [
    "request",
    "list",
    ...(thread ? ["--thread", thread] : []),
    "--json",
  ]);
  expect(listed.code, listed.stderr).toBe(0);
  return requestList.parse(JSON.parse(listed.stdout)).requests;
}

test("old spellings reach the same thread reads as the new grammar", async () => {
  const f = await daemonFixture();
  try {
    const threads = z.object({ threads: z.array(z.object({ id: z.string() })) });
    const old = await cli(f, ["threads", "list", "--json"]);
    const now = await cli(f, ["thread", "list", "--json"]);
    expect(old.code, old.stderr).toBe(0);
    expect(now.code, now.stderr).toBe(0);
    expect(threads.parse(JSON.parse(old.stdout))).toEqual(threads.parse(JSON.parse(now.stdout)));

    const shown = z.object({ thread: z.object({ id: z.string() }), items: z.array(z.unknown()) });
    const read = await cli(f, ["thread", "read", f.caller.threadId, "--json"]);
    const show = await cli(f, ["thread", "show", f.caller.threadId, "--json"]);
    expect(read.code, read.stderr).toBe(0);
    expect(show.code, show.stderr).toBe(0);
    expect(shown.parse(JSON.parse(read.stdout)).thread.id).toBe(f.caller.threadId);
    expect(shown.parse(JSON.parse(show.stdout)).thread.id).toBe(f.caller.threadId);
    // A prefix of the id names the same thread.
    const byPrefix = await cli(f, ["thread", "show", f.caller.threadId.slice(0, 12), "--json"]);
    expect(byPrefix.code, byPrefix.stderr).toBe(0);
    expect(shown.parse(JSON.parse(byPrefix.stdout)).thread.id).toBe(f.caller.threadId);
  } finally {
    await f.daemon.close();
  }
});

test("task spawn, status, wait and cancel reach the same operations as thread start, status, wait and stop", async () => {
  const f = await daemonFixture();
  try {
    const spawned = z.object({ data: z.object({ threadId: z.string() }) });
    const common = ["--parent", f.caller.threadId, "--provider", "claude", "--json"];
    const old = await cli(f, ["task", "spawn", "Synthetic old", "--role", "old", ...common]);
    const now = await cli(f, ["thread", "start", "Synthetic new", "--role", "new", ...common]);
    expect(old.code, old.stderr).toBe(0);
    expect(now.code, now.stderr).toBe(0);
    const oldChild = spawned.parse(JSON.parse(old.stdout)).data.threadId;
    const newChild = spawned.parse(JSON.parse(now.stdout)).data.threadId;
    await f.daemon.engine?.flush();

    const state = z.object({ state: z.string() });
    const oldStatus = await cli(f, ["task", "status", oldChild, "--json"]);
    const newStatus = await cli(f, ["thread", "status", oldChild, "--json"]);
    expect(newStatus.code).toBe(oldStatus.code);
    expect(state.parse(JSON.parse(newStatus.stdout)).state).toBe(
      state.parse(JSON.parse(oldStatus.stdout)).state,
    );

    const oldWait = await cli(f, ["task", "wait", oldChild, "--timeout", "1s", "--json"]);
    const newWait = await cli(f, [
      "thread",
      "wait",
      oldChild,
      "--tree",
      "--timeout",
      "1s",
      "--json",
    ]);
    expect(newWait.code).toBe(oldWait.code);

    const cancelled = await cli(f, ["task", "cancel", oldChild, "--json"]);
    const stopped = await cli(f, ["thread", "stop", newChild, "--json"]);
    expect(cancelled.code, cancelled.stderr).toBe(0);
    expect(stopped.code, stopped.stderr).toBe(0);
  } finally {
    await f.daemon.close();
  }
});

test("kill-all and add reach the same operations as thread stop --all and project add", async () => {
  const f = await daemonFixture();
  try {
    const killAll = await cli(f, ["kill-all", "--provider", "codex", "--json"]);
    const stopAll = await cli(f, ["thread", "stop", "--all", "--provider", "codex", "--json"]);
    expect(stopAll.code).toBe(killAll.code);
    expect(Object.keys(JSON.parse(stopAll.stdout)).toSorted()).toEqual(
      Object.keys(JSON.parse(killAll.stdout)).toSorted(),
    );

    const outcome = z.object({
      workspace: z.object({ id: z.string() }).optional(),
      code: z.string().optional(),
    });
    const added = await cli(f, ["add", f.h.home, "--json"]);
    const projectAdded = await cli(f, ["project", "add", f.h.home, "--json"]);
    expect(projectAdded.code).toBe(added.code);
    const [a, b] = [added, projectAdded].map((run) => outcome.parse(JSON.parse(run.stdout)));
    expect(b?.workspace?.id ?? b?.code).toBe(a?.workspace?.id ?? a?.code);
  } finally {
    await f.daemon.close();
  }
});

test("thread approve and request allow both answer an open approval", async () => {
  const f = await daemonFixture();
  try {
    const child = await spawn(f, "asker");
    await emit(f, child, approval("first"));
    const [first] = await openRequests(f, child);
    expect(first?.threadId).toBe(child);
    const approved = await cli(f, [
      "thread",
      "approve",
      child,
      "--interaction",
      first?.interaction.id ?? "missing",
      "--json",
    ]);
    expect(approved.code, approved.stderr).toBe(0);
    await f.daemon.engine?.flush();
    expect(f.daemon.store.getInteraction(first?.interaction.id ?? "")?.state).toBe("resolved");

    await emit(f, child, approval("second"));
    const [second] = await openRequests(f);
    const allowed = await cli(f, [
      "request",
      "allow",
      second?.interaction.id ?? "missing",
      "--json",
    ]);
    expect(allowed.code, allowed.stderr).toBe(0);
    await f.daemon.engine?.flush();
    expect(f.daemon.store.getInteraction(second?.interaction.id ?? "")?.state).toBe("resolved");
  } finally {
    await f.daemon.close();
  }
});

test("request answer resolves an agent's question with the chosen option", async () => {
  const f = await daemonFixture();
  try {
    const child = await spawn(f, "questioner");
    await emit(f, child, {
      type: "interaction.opened",
      agent: "root",
      interaction: "ask",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "db",
            text: "Which database?",
            options: [
              { id: "pg", label: "Postgres" },
              { id: "sqlite", label: "SQLite" },
            ],
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
        ],
      },
    });
    const [question] = await openRequests(f);
    expect(question?.threadId).toBe(child);
    const id = question?.interaction.id ?? "missing";

    // Allowing a question is the wrong verb: a usage error, nothing answered.
    const wrong = await cli(f, ["request", "allow", id, "--json"]);
    expect(wrong.code).toBe(64);
    expect(f.daemon.store.getInteraction(id)?.state).toBe("pending");

    const answered = await cli(f, [
      "request",
      "answer",
      id.slice(0, 8),
      "--choice",
      "sqlite",
      "--json",
    ]);
    expect(answered.code, answered.stderr).toBe(0);
    await f.daemon.engine?.flush();
    const resolved = f.daemon.store.getInteraction(id);
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolution).toEqual({ kind: "question", answers: { db: ["sqlite"] } });
    expect(await openRequests(f)).toEqual([]);
  } finally {
    await f.daemon.close();
  }
});

test("without a terminal nothing prompts: a missing argument exits 64 naming it", async () => {
  const f = await daemonFixture();
  try {
    for (const [args, argument] of [
      [["thread", "show"], "THREAD"],
      [["request", "allow"], "REQUEST"],
      [["request", "answer"], "REQUEST"],
      [["thread", "snooze", f.caller.threadId], "--until"],
    ] as const) {
      const run = await cli(f, [...args, "--json"], "typed into a pipe\n");
      expect(run.code, `${args.join(" ")}: ${run.stdout}`).toBe(64);
      expect(JSON.parse(run.stdout)).toMatchObject({ status: "usage", argument });
    }
    // A missing prompt reads stdin only when asked with -.
    const started = await cli(
      f,
      ["thread", "start", "--project", f.workspace, "--json"],
      "ignored",
    );
    expect(started.code).toBe(64);
  } finally {
    await f.daemon.close();
  }
});
