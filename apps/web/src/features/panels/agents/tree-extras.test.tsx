import { Client, ThreadStore, defaultLimits } from "@ace/client";
import { ClientProvider, ThreadWindowProvider } from "@ace/client-react";
import { Agent, DeviceId, Event, ThreadView } from "@ace/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AgentCounts } from "./tree-extras.tsx";

afterEach(cleanup);
test("a mounted Agents summary follows each child's status without calling failures done", async () => {
  const store = new ThreadStore(defaultLimits);
  const view = ThreadView.parse({
    kind: "thread",
    seq: 0,
    thread: {
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title: "Agents",
      status: { state: "done" },
      createdAt: 0,
      updatedAt: 0,
    },
    agents: {},
    runs: {},
    items: {},
    itemOrder: [],
    interactions: {},
    backgroundTasks: {},
    usage: {},
    usageSnapshots: {},
    agentChildren: {},
  });
  view.agents.child = Agent.parse({
    id: "child",
    threadId: "thread",
    parentId: null,
    origin: "provider_subagent",
    native: { provider: "codex", id: "child" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 0,
  });
  store.snapshot(view);
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test"),
    transport: () => ({ open() {}, send() {}, close() {} }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => `id-${++id}`,
  });
  render(
    <ClientProvider client={client}>
      <ThreadWindowProvider threadId="thread" source={store}>
        <AgentCounts threadId="thread" />
      </ThreadWindowProvider>
    </ClientProvider>,
  );
  expect(screen.getByRole("status").textContent).toBe("No active subagents · 1 done");
  let seq = 0;
  const status = async (value: unknown, expected: string) => {
    const afterSeq = seq++;
    await act(async () => {
      store.delivery({
        type: "events",
        subscriptionId: "thread",
        afterSeq,
        throughSeq: seq,
        events: [
          Event.parse({
            id: `event-${seq}`,
            threadId: "thread",
            seq,
            at: 0,
            payload: { type: "agent.status", agentId: "child", status: value },
          }),
        ],
      });
    });
    expect(screen.getByRole("status").textContent).toBe(expected);
  };
  await status({ state: "working", activity: "thinking" }, "1 active · 0 done");
  await status({ state: "idle" }, "No active subagents · 1 done");
  await status({ state: "blocked", on: "human", refs: [] }, "1 active · 0 done");
  await status(
    { state: "failed", error: { kind: "unknown", message: "Failed" } },
    "No active subagents · 0 done · 1 failed",
  );
  await status(
    { state: "unresponsive", lastSignalAt: 0 },
    "No active subagents · 0 done · 1 unresponsive",
  );
  await client.close();
});
