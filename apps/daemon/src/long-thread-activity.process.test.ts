import { expect, test } from "vitest";
import { Agent, AgentId, RunId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import {
  storeFixture,
  root,
  start,
  end,
  tool,
  turns,
  approval,
} from "./long-thread-test-support.ts";

// Mutations: borrowing the later root turn's working status, mapping a network wait to
// working, or dropping the rate-limit deadline. Not executed (tests run at merge).
test("an earlier turn preserves a child network wait and rate-limit deadline while the root runs again", () => {
  const f = storeFixture();
  const child = AgentId.parse("blocked-child");
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: child,
          threadId: f.thread.id,
          parentId: root,
          origin: "provider_subagent",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "blocked", on: "network", refs: [], message: "Reconnecting" },
          createdAt: 25,
        }),
      },
    ],
    25,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "run.started",
        run: {
          id: RunId.parse("blocked-child-run"),
          threadId: f.thread.id,
          agentId: child,
          trigger: "spawn",
          state: "active",
          startedAt: 26,
        },
      },
    ],
    26,
  );
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    ordinal: 1,
    status: { state: "waiting", on: "network" },
  });
  expect(turns(f.store, f.thread).turns[0]?.endedAt).toBeUndefined();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.status",
        agentId: child,
        status: { state: "blocked", on: "rate_limit", refs: [], until: 9000 },
      },
    ],
    50,
  );
  const [limited, current] = turns(f.store, f.thread).turns;
  expect(limited).toMatchObject({ ordinal: 1, status: { state: "limited", until: 9000 } });
  expect(limited?.endedAt).toBeUndefined();
  expect(limited?.subagents[0]?.status).toEqual({ state: "limited", until: 9000 });
  expect(current).toMatchObject({ ordinal: 2, outcome: "active", status: { state: "working" } });
});

// Mutations: returning a linked child's working status before checking local human
// interactions, assigning a tool-backed late approval to the latest root turn.
// Not executed (tests run at merge).
test("an earlier turn's pending human approval takes priority over a linked working child", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "permission-owner",
          "succeeded",
          { kind: "shell", command: "prepare", exitCode: 0 },
          "first",
        ),
      },
    ],
    21,
  );
  const child = createDevThread(f.store, f.workspace, "Linked working child");
  const childRoot = AgentId.parse("linked-working-root");
  f.store.appendEvents(
    child.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: childRoot,
          threadId: child.id,
          parentId: null,
          origin: "root",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "working", activity: "thinking" },
          createdAt: 25,
        }),
      },
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ],
    25,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: "linked-working-proxy",
          threadId: f.thread.id,
          parentId: root,
          childThreadId: child.id,
          origin: "ace",
          fidelity: "summary",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "idle" },
          createdAt: 25,
        }),
      },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "interaction.opened",
        interaction: approval(f.thread, "human-first", "permission-owner"),
      },
    ],
    35,
  );
  start(f.store, f.thread, "second", 40);
  const historical = turns(f.store, f.thread).turns[0];
  expect(historical).toMatchObject({
    ordinal: 1,
    status: { state: "needs_you", interactions: 1 },
    digest: { approvalsAsked: 1, approvalsPending: 1 },
  });
  expect(historical?.endedAt).toBeUndefined();
  expect(historical?.subagents[0]?.status.state).toBe("working");
});

// Mutations: classifying agents waiting on their subagents as background-task waiting,
// discarding active work when its parent is blocked. Not executed (tests run at merge).
test("a historical child waiting on its subagents still represents ongoing agent work", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: "coordinator-child",
          threadId: f.thread.id,
          parentId: root,
          origin: "provider_subagent",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "blocked", on: "subagents", refs: ["native-grandchild"] },
          createdAt: 25,
        }),
      },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  const historical = turns(f.store, f.thread).turns[0];
  expect(historical).toMatchObject({ ordinal: 1, status: { state: "working" } });
  expect(historical?.subagents[0]?.status.state).toBe("working");
  expect(historical?.endedAt).toBeUndefined();
});
