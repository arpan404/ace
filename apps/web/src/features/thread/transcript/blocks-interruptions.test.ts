import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Thread } from "@ace/protocol";
import { turnHeadLabel } from "@ace/ui-core";
import { expect, test } from "vitest";
import { createBlockReader } from "./block-reader.ts";
import type { Block } from "./blocks.ts";

/*
 * How interruptions and provider retries read in the transcript, from the events the daemon
 * records: a restart is no stop the person made, a retry the provider recovers from is gone
 * once it recovers, and a turn ace continued after a restart works until its last run ends.
 */

const minute = 60_000;
const threadView = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Interruptions",
  rootAgentId: "root",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});

function recorded() {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(threadView));
  let seq = 0;
  // Payloads are parsed as the store receives them, brands and defaults included.
  const admit = (at: number, ...payloads: unknown[]) => {
    for (const payload of payloads) {
      seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [Event.parse({ id: `event-${seq}`, seq, at, threadId: threadView.id, payload })],
      });
    }
  };
  admit(0, {
    type: "agent.created",
    agent: {
      id: "root",
      threadId: threadView.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex", nativeId: "root" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "working", activity: "thinking" },
      createdAt: 0,
    },
  });
  const read = createBlockReader();
  return { store, admit, blocks: () => read(store).value };
}

const ask = (id: string, at: number, runId?: string) => ({
  type: "item.created",
  item: {
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text: id }],
    origin: { kind: "person", commandId: `send-${id}` },
    ...(runId ? { runId } : {}),
  },
});
const restartInput = (id: string, at: number) => ({
  type: "item.created",
  item: {
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    type: "message",
    role: "user",
    synthetic: true,
    parts: [{ type: "text", text: "continue" }],
    origin: { kind: "restart", commandId: `restart-${id}` },
  },
});
const step = (id: string, runId: string, at: number) => ({
  type: "item.created",
  item: {
    id,
    agentId: "root",
    runId,
    createdAt: at,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: id,
      detail: { kind: "shell", command: `run ${id}` },
      status: "succeeded",
      startedAt: at,
      raw: [],
    },
  },
});
const started = (id: string, at: number, trigger: "user" | "restart", turn?: number) => ({
  type: "run.started",
  run: {
    id,
    threadId: threadView.id,
    agentId: "root",
    trigger,
    state: "active",
    startedAt: at,
    ...(turn ? { turn } : {}),
  },
});
const ended = (runId: string, at: number, state: "completed" | "interrupted" | "failed") => ({
  type: "run.ended",
  runId,
  state,
  endedAt: at,
});
const status = (next: { type: "agent.status"; agentId: string; status: unknown }) => next;
const settled = (state: "idle" | "interrupted") =>
  status({ type: "agent.status", agentId: "root", status: { state } });
const queue = (reason: "restart" | "stopped" | null) => ({
  type: "queue.updated",
  revision: 1,
  paused: reason !== null,
  reason,
  resumeAt: null,
});
/** Codex's own `error` notification as a notice; recorded before adapters coded retries, uncoded. */
const codexError = (
  id: string,
  runId: string,
  at: number,
  willRetry: boolean,
  coded = willRetry,
) => ({
  type: "item.created",
  item: {
    id,
    agentId: "root",
    runId,
    createdAt: at,
    complete: true,
    type: "notice",
    level: "info",
    text: willRetry ? "Reconnecting... 2/5" : "stream disconnected before completion",
    ...(coded ? { code: "provider.retry" } : {}),
    raw: [
      {
        type: "error",
        data: {
          method: "error",
          params: { willRetry, error: { message: "Reconnecting... 2/5" }, threadId: "native" },
        },
      },
    ],
  },
});

const head = (blocks: readonly Block[]) => {
  const block = blocks.find((entry) => entry.kind === "work" && entry.outcome !== undefined);
  if (block?.kind !== "work" || block.until === undefined || block.startedAt === undefined)
    return undefined;
  return turnHeadLabel(
    block.outcome,
    block.restarted === true,
    block.until - block.startedAt - (block.idle ?? 0),
  );
};
const rows = (blocks: readonly Block[]) => blocks.flatMap((block) => blockIds(block));
const blockIds = (block: Block): string[] =>
  block.kind === "work" ? block.itemIds : [("itemId" in block && block.itemId) || block.kind];

test("a run interrupted by a daemon restart reads as interrupted, not stopped", () => {
  const thread = recorded();
  thread.admit(0, ask("ask", 0), started("first", 0, "user", 1), step("read", "first", 1_000));
  // The app quit: the run ends interrupted, and on restart the queue holds for it.
  thread.admit(3 * minute + 5_000, ended("first", 3 * minute + 5_000, "interrupted"));
  thread.admit(3 * minute + 5_000, settled("interrupted"), queue("restart"));
  expect(head(thread.blocks())).toBe("Interrupted after 3m 5s");
});

test("a run the person stopped still reads as stopped", () => {
  const thread = recorded();
  thread.admit(0, ask("ask", 0), started("first", 0, "user", 1), step("read", "first", 1_000));
  thread.admit(65_000, ended("first", 65_000, "interrupted"), settled("interrupted"));
  thread.admit(65_000, queue("stopped"));
  expect(head(thread.blocks())).toBe("Stopped after 1m 5s");
});

test("a turn ace continued after a restart keeps working until the continuation ends", () => {
  const thread = recorded();
  thread.admit(0, ask("ask", 0), started("first", 0, "user", 1), step("read", "first", 1_000));
  thread.admit(2 * minute, ended("first", 2 * minute, "interrupted"), settled("interrupted"));
  thread.admit(2 * minute, queue("restart"));
  // Back up a minute later: ace's Continue runs in the same turn, and the person steers into it.
  const back = 3 * minute;
  thread.admit(back, restartInput("continue", back), queue(null));
  thread.admit(back, started("continued", back, "restart", 1));
  thread.admit(back, status({ type: "agent.status", agentId: "root", status: working }));
  thread.admit(back + 1_000, ask("steer", back + 1_000, "continued"));
  thread.admit(back + 2_000, step("write", "continued", back + 2_000));
  const live = thread.blocks();
  // Never "Stopped" or "Interrupted" while the continuation works: one live line, no head.
  expect(live.filter((block) => block.kind === "live")).toHaveLength(1);
  expect(head(live)).toBeUndefined();
  expect(rows(live)).toContain("continue");

  thread.admit(back + 30_000, ended("continued", back + 30_000, "completed"), settled("idle"));
  // Its time leaves out the minute the app was down.
  expect(head(thread.blocks())).toBe("Worked for 2m 30s");
});

test("a provider retry that recovers leaves no row in the transcript", () => {
  const thread = recorded();
  thread.admit(0, ask("ask", 0), started("run", 0, "user", 1), step("read", "run", 1_000));
  thread.admit(2_000, codexError("retry", "run", 2_000, true, false));
  thread.admit(2_000, {
    type: "agent.status",
    agentId: "root",
    status: { state: "blocked", on: "network", refs: [], message: "Reconnecting... 2/5" },
  });
  expect(rows(thread.blocks())).not.toContain("retry");
  thread.admit(9_000, status({ type: "agent.status", agentId: "root", status: working }));
  thread.admit(10_000, step("write", "run", 10_000), ended("run", 12_000, "completed"));
  thread.admit(12_000, settled("idle"));
  expect(rows(thread.blocks())).not.toContain("retry");
  // Still kept, raw frame and all.
  const kept = thread.store.item("retry");
  expect(kept?.type === "notice" && kept.raw).toHaveLength(1);
});

test("a retry that gives up stays visible", () => {
  const thread = recorded();
  thread.admit(0, ask("ask", 0), started("run", 0, "user", 1), step("read", "run", 1_000));
  thread.admit(2_000, codexError("retry", "run", 2_000, true));
  thread.admit(8_000, codexError("gave-up", "run", 8_000, false));
  thread.admit(9_000, ended("run", 9_000, "failed"), settled("idle"));
  const shown = rows(thread.blocks());
  expect(shown).toContain("gave-up");
  expect(shown).not.toContain("retry");
});

const working = { state: "working", activity: "tool" } as const;
