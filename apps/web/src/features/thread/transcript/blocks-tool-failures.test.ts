import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Thread } from "@ace/protocol";
import { describeStep, stepLabels } from "@ace/ui-core";
import { aceToolLog } from "@ace/ui-core/ace-tools";
import { expect, test } from "vitest";
import { createBlockReader } from "./block-reader.ts";

/*
 * A failed ace tool call is one row: its step in the work log reads as failed, in a person's
 * words. The daemon's report of the failure folds into that step; with no step to fold into, it
 * keeps a row of its own, so a failure is never hidden.
 */

const threadView = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "claude",
  title: "Tool failures",
  rootAgentId: "root",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const hint =
  "The tool failed without a public reason. Do not send the identical call again: check the target's current state, change the request, or tell the person.";
const failure = {
  isError: true,
  durationMs: 12,
  content: [{ type: "text", text: JSON.stringify({ code: "execution_failed", hint }) }],
};

function recorded() {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(threadView));
  let seq = 0;
  // Payloads are parsed as the store receives them, brands and defaults included.
  const admit = (...payloads: unknown[]) => {
    for (const payload of payloads) {
      seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [Event.parse({ id: `e${seq}`, seq, at: seq, threadId: "thread", payload })],
      });
    }
  };
  admit(
    {
      type: "run.started",
      run: {
        id: "run",
        threadId: "thread",
        agentId: "root",
        trigger: "user",
        state: "active",
        startedAt: 0,
      },
    },
    ask(),
  );
  const read = createBlockReader();
  /** What the person sees: standalone rows, and each work log's steps as they read. */
  const shown = () =>
    read(store).value.flatMap((block) => {
      if (block.kind === "item") return [`row: ${store.item(block.itemId)?.type}`];
      if (block.kind !== "work") return [];
      const items = block.itemIds.map((id) => store.item(id));
      const log = aceToolLog(block.itemIds, items);
      const visible = new Set(
        log.rows.flatMap((row) => (row.kind === "group" ? row.ids : [row.id])),
      );
      return block.itemIds.flatMap((id) => {
        const item = store.item(id);
        if (!item || !visible.has(id)) return [];
        const step = describeStep(item, { labels: stepLabels, ace: log.contexts[id] });
        return [`step: ${step.verb}${step.failed ? " (failed)" : ""}`];
      });
    });
  return { admit, shown, text: () => JSON.stringify(shown()) };
}

const ask = () => ({
  type: "item.created",
  item: {
    id: "ask",
    agentId: "root",
    createdAt: 0,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text: "Read the other thread" }],
    origin: { kind: "person", commandId: "send-ask" },
  },
});
const read = (status: "running" | "failed", result?: unknown) => ({
  type: status === "running" ? "item.created" : "item.updated",
  item: {
    id: "read",
    agentId: "root",
    runId: "run",
    createdAt: 1,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id: "read",
      agentId: "root",
      kind: "mcp",
      title: "thread_read",
      status,
      detail: {
        kind: "mcp",
        server: "ace",
        tool: "thread_read",
        arguments: { threadId: "other" },
      },
      startedAt: 1,
      raw: [],
      ...(result ? { result, error: "Tool execution failed" } : {}),
    },
  },
});
/** The daemon's report, worded as the public catalog tells the agent. */
const report = (id: string) => ({
  type: "item.created",
  item: {
    id,
    agentId: "root",
    createdAt: 2,
    complete: true,
    type: "notice",
    level: "error",
    code: "execution_failed",
    title: "Tool execution failed",
    text: hint,
    raw: [{ type: "ace.agent_control.failed", data: { operation: "thread.read" } }],
  },
});

test("a failed ace tool call appears once, on its step, with plain wording", () => {
  const thread = recorded();
  // The daemon reports the failure before the call's own result arrives.
  thread.admit(read("running"), report("report"));
  // Until the step itself reads as failed, the report keeps the failure in view.
  expect(thread.shown().filter((row) => row.includes("Couldn't read a thread"))).toHaveLength(1);
  thread.admit(read("failed", failure));
  expect(thread.shown()).toEqual(["step: Couldn't read a thread (failed)"]);
  expect(thread.text()).not.toMatch(/Do not send|Tool execution failed/);
});

test("a failure report with no step of its own keeps its own row", () => {
  const thread = recorded();
  thread.admit(report("lone"));
  expect(thread.shown()).toEqual(["row: notice"]);
});
