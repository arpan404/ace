import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread, Store } from "./index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).toReversed()) close();
});
function database() {
  const home = mkdtempSync(join(tmpdir(), "ace-mcp-upgrade-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const store = new Store(path);
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("/test", "Test");
  const thread = createDevThread(store, workspace);
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/test",
    status: { state: "idle" },
    createdAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  return { path, store, thread, agent };
}

it("accepts repeated agent creation and publishes the replacement with later status", () => {
  const { store, thread, agent } = database();
  const before = store.headSeq();
  const replacement = Agent.parse({ ...agent, cwd: "/replacement" });
  store.appendEvents(
    thread.id,
    [
      { type: "agent.created", agent: replacement },
      { type: "agent.status", agentId: agent.id, status: { state: "working", activity: "tool" } },
    ],
    2,
  );
  expect(store.getMcpAgent(thread.id, agent.id)).toMatchObject({
    cwd: "/replacement",
    status: { state: "working", activity: "tool" },
  });
  const events = store.readEvents({ threadId: thread.id, afterSeq: before, limit: 10 });
  expect(
    events.filter((event) => event.payload.type.startsWith("agent.")).map((event) => event.payload),
  ).toEqual([
    { type: "agent.created", agent: replacement },
    { type: "agent.status", agentId: agent.id, status: { state: "working", activity: "tool" } },
  ]);
  expect(events.map((event) => event.seq)).toEqual(
    Array.from({ length: store.headSeq() - before }, (_, i) => before + i + 1),
  );
});

it("upgrades a pre-MCP database containing repeated creation and retains the latest agent", () => {
  const { path, store, thread, agent } = database();
  store.appendEvents(
    thread.id,
    [{ type: "agent.created", agent: { ...agent, cwd: "/upgraded" } }],
    2,
  );
  store.close();
  // Remove the derived MCP tables to reproduce an event log awaiting MCP backfill.
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE mcp_agents; DROP TABLE mcp_intents; DROP TABLE mcp_meta;");
  legacy.close();
  const upgraded = new Store(path);
  cleanups.push(() => upgraded.close());
  expect(upgraded.listMcpAgents(thread.id, "", 10)).toMatchObject([
    { id: "root", cwd: "/upgraded" },
  ]);
  upgraded.appendEvents(
    thread.id,
    [{ type: "agent.status", agentId: agent.id, status: { state: "idle" } }],
    3,
  );
  expect(upgraded.getMcpAgent(thread.id, agent.id)).toMatchObject({
    cwd: "/upgraded",
    status: { state: "idle" },
  });
});
it("deleting a thread removes its MCP callers and pending intents while preserving other threads", () => {
  const { path, store, thread, agent } = database();
  const other = createDevThread(store, thread.workspaceId);
  const otherAgent = Agent.parse({ ...agent, id: "other", threadId: other.id });
  store.appendEvents(other.id, [{ type: "agent.created", agent: otherAgent }], 2);
  for (const [id, owner] of [
    ["deleted", agent],
    ["retained", otherAgent],
  ] as const)
    store.enqueueMcpIntent(
      id,
      {
        type: "mcp.spawn",
        sessionId: "s",
        threadId: owner.threadId,
        agentId: owner.id,
        input: { task: "Synthetic queued task" },
      },
      [],
      3,
    );
  store.deleteThread(thread.id);
  expect(store.getThread(thread.id)).toBeUndefined();
  expect(store.getMcpAgent(thread.id, agent.id)).toBeUndefined();
  expect(store.listMcpAgents(thread.id, "", 10)).toEqual([]);
  expect(store.readMcpIntents().map((row) => row.id)).toEqual(["retained"]);
  expect(store.getMcpAgent(other.id, otherAgent.id)).toEqual(otherAgent);
  const reopened = new Store(path);
  cleanups.push(() => reopened.close());
  expect(reopened.listMcpAgents(thread.id, "", 10)).toEqual([]);
  expect(reopened.readMcpIntents().map((row) => row.id)).toEqual(["retained"]);
  expect(reopened.acknowledgeMcpIntent("retained")).toBe(true);
  expect(reopened.readMcpIntents()).toEqual([]);
});
