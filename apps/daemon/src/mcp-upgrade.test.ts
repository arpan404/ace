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
  expect(store.headSeq()).toBe(before + 2);
  expect(store.getMcpAgent(thread.id, agent.id)).toMatchObject({
    cwd: "/replacement",
    status: { state: "working", activity: "tool" },
  });
  expect(store.readEvents({ threadId: thread.id, afterSeq: before, limit: 10 })).toHaveLength(2);
});

it("upgrades a pre-MCP database containing repeated creation and retains the latest agent", () => {
  const { path, store, thread, agent } = database();
  const seq = store.headSeq() + 1;
  store.close();
  // A real pre-MCP event log has no MCP tables and allows repeated agent.created records.
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE mcp_agents; DROP TABLE mcp_intents; DROP TABLE mcp_meta;");
  legacy
    .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      seq,
      "repeated-creation",
      thread.id,
      2,
      "agent.created",
      JSON.stringify({ type: "agent.created", agent: { ...agent, cwd: "/upgraded" } }),
    );
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
