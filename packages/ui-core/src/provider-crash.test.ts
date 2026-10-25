import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { errorRowText, failedTurnView } from "./failed-turn.ts";
import { queueNotice, stopTitle } from "./queue.ts";
import { createBlockReader } from "./transcript-block-reader.ts";
import type { Block } from "./transcript-blocks.ts";

/*
 * A provider whose process dies mid-turn, as the daemon records it: the adapter's notice, the
 * run and agent failing with the provider's reason, ace's own "The agent stopped unexpectedly"
 * and the queue holding the turn for Continue. It reads as one stop, called a crash, with one
 * action; a daemon restart keeps its own name.
 */

const reason =
  "Cursor stopped unexpectedly: host ran out of memory. Unfinished work needs your attention.";
const threadView = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "cursor",
  title: "Crash",
  rootAgentId: "root",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});

function recorded() {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(threadView));
  let seq = 0;
  const admit = (...payloads: unknown[]) => {
    for (const payload of payloads) {
      seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [
          Event.parse({ id: `event-${seq}`, seq, at: seq, threadId: threadView.id, payload }),
        ],
      });
    }
  };
  admit({
    type: "agent.created",
    agent: {
      id: "root",
      threadId: threadView.id,
      parentId: null,
      origin: "root",
      native: { provider: "cursor", nativeId: "root" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "working", activity: "thinking" },
      createdAt: 0,
    },
  });
  const read = createBlockReader();
  return { store, admit, blocks: () => read(store).value };
}

const item = (fields: Record<string, unknown>) => ({
  type: "item.created",
  item: { agentId: "root", createdAt: 1, complete: true, ...fields },
});
const ask = item({
  id: "ask",
  type: "message",
  role: "user",
  parts: [{ type: "text", text: "fix the bug" }],
  origin: { kind: "person", commandId: "send-ask" },
});
const started = {
  type: "run.started",
  run: {
    id: "run",
    threadId: threadView.id,
    agentId: "root",
    trigger: "user",
    state: "active",
    startedAt: 1,
    turn: 1,
  },
};
const step = item({
  id: "read",
  runId: "run",
  type: "tool_call",
  call: {
    id: "read",
    agentId: "root",
    kind: "shell",
    title: "read",
    detail: { kind: "shell", command: "cat file" },
    status: "succeeded",
    startedAt: 2,
    raw: [],
  },
});
/** The Cursor adapter's own report of the host exit. */
const adapterStop = item({
  id: "adapter-stop",
  runId: "run",
  type: "notice",
  level: "warning",
  diagnostic: true,
  code: "cursor.work-stopped",
  text: "Cursor stopped unexpectedly. Unfinished work needs your attention.",
});
/** ace's own transcript notice for a provider that died with work in flight. */
const aceStop = item({
  id: "liveness:stopped:9",
  type: "notice",
  level: "warning",
  code: "agent_stopped",
  text: "The agent stopped unexpectedly",
});
const ended = (state: "failed" | "interrupted") => ({
  type: "run.ended",
  runId: "run",
  state,
  endedAt: 9,
});
const failed = {
  type: "agent.status",
  agentId: "root",
  status: { state: "failed", error: { kind: "process_exit", message: reason } },
};
const interrupted = { type: "agent.status", agentId: "root", status: { state: "interrupted" } };
const held = (exited: boolean) => ({
  type: "queue.updated",
  revision: 2,
  paused: true,
  reason: "restart",
  ...(exited ? { exited: true } : {}),
  resumeAt: null,
});
const released = {
  type: "queue.updated",
  revision: 3,
  paused: false,
  reason: null,
  resumeAt: null,
};

const shownIds = (blocks: readonly Block[]) =>
  blocks.flatMap((block) => ("itemId" in block && block.itemId ? [block.itemId] : []));
const endOf = (blocks: readonly Block[]) => {
  const ends = blocks.filter((block) => block.kind === "end");
  expect(ends).toHaveLength(1);
  const end = ends[0];
  if (end?.kind !== "end") throw new Error("No ending");
  return end;
};
/** The failed turn's row, as both clients draw it from the block. */
const failedRow = (end: Extract<Block, { kind: "end" }>) =>
  failedTurnView({
    notice: undefined,
    error: failed.status.error,
    provider: "cursor",
    model: undefined,
    latest: end.latest === true,
    held: end.held,
  });

test("a provider crash mid-turn is held as a crash, not a restart, with Continue", () => {
  const thread = recorded();
  thread.admit(ask, started, step, adapterStop, ended("failed"), failed, aceStop, held(true));
  const queue = thread.store.queue;
  expect(stopTitle(queue, "cursor")).toBe("Cursor stopped unexpectedly");
  expect(stopTitle(queue)).toBe("Agent stopped unexpectedly");
  const notice = queueNotice(thread.store.thread?.status, queue, 0);
  expect(notice?.title).toBe("Agent stopped unexpectedly");
  expect(notice?.actions).toEqual([{ id: "continue", label: "Continue" }]);
});

test("a daemon restart still reads as a restart", () => {
  const thread = recorded();
  thread.admit(ask, started, step, ended("interrupted"), interrupted, held(false));
  expect(stopTitle(thread.store.queue, "cursor")).toBe("Stopped by a restart");
  expect(queueNotice(undefined, thread.store.queue, 0)?.title).toBe("Stopped by a restart");
});

test("a crashed turn reads as one stop line carrying the provider's reason, and one action", () => {
  const thread = recorded();
  thread.admit(ask, started, step, adapterStop, ended("failed"), failed, aceStop, held(true));
  const blocks = thread.blocks();
  // Neither notice repeats what the failed turn's row says.
  expect(shownIds(blocks)).not.toContain("adapter-stop");
  expect(shownIds(blocks)).not.toContain("liveness:stopped:9");
  const end = endOf(blocks);
  expect(end).toMatchObject({ ending: "failed", latest: true, held: true });
  const row = failedRow(end);
  expect(errorRowText(row.error, row.heading)).toMatchObject({
    title: "Turn failed",
    message: reason,
  });
  // The stop's pill offers Continue; the row offers no Retry beside it.
  expect(row.retry).toBe(false);
});

test("once nothing holds the crashed turn, its row offers Retry again", () => {
  const thread = recorded();
  thread.admit(ask, started, step, adapterStop, ended("failed"), failed, aceStop, held(true));
  thread.admit(released);
  const blocks = thread.blocks();
  expect(shownIds(blocks)).not.toContain("liveness:stopped:9");
  const end = endOf(blocks);
  expect(end.held).toBeUndefined();
  expect(failedRow(end).retry).toBe(true);
});

test("a crash that leaves its turn interrupted keeps ace's notice and drops the adapter's", () => {
  const thread = recorded();
  thread.admit(ask, started, step, adapterStop, ended("interrupted"), interrupted, aceStop);
  thread.admit(held(true));
  const shown = shownIds(thread.blocks());
  expect(shown).toContain("liveness:stopped:9");
  expect(shown).not.toContain("adapter-stop");
});
