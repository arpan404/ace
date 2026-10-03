import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Agent,
  DeviceCredential,
  ItemId,
  McpNotificationIntent,
  McpScope,
  PairingResponse,
  type EventPayload,
} from "@ace/protocol";
import { z } from "zod";
import { ScreenManager } from "@ace/screen";
import { afterEach, expect, it } from "vitest";
import { startDaemon, readConfig, createDevThread, Store } from "./index.ts";
import { startDaemonMcp } from "./mcp.ts";
import { accessRequest, redeemPairing } from "./client-access.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function home() {
  const path = mkdtempSync(join(tmpdir(), "ace-daemon-mcp-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function seed(store: Store) {
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
  const scope = McpScope.parse({
    sessionId: "provider-session",
    threadId: thread.id,
    agentId: agent.id,
    capabilities: ["notify", "agents"],
  });
  return { thread, agent, scope };
}
async function call(url: string, bearer: string, name: string, args: unknown = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return response;
}

it("serves remote device access alongside isolated MCP authority and shuts down both", async () => {
  const directory = home();
  const config = readConfig({
    ACE_HOME: directory,
    ACE_PORT: "0",
    ACE_REMOTE_PORT: "0",
    ACE_LISTEN: "lan",
    ACE_ADVERTISE_HOST: "127.0.0.1",
    ACE_LOG_LEVEL: "silent",
  });
  const daemon = await startDaemon({ config: config });
  cleanups.push(() => daemon.close());
  const { scope } = seed(daemon.store);
  const lease = daemon.mcp.openSession(scope, new AbortController().signal);
  const endpointPath = join(directory, "daemon-endpoint");
  const local = readFileSync(endpointPath, "utf8");
  const token = readFileSync(daemon.tokenPath, "utf8").trim();
  const pairing = PairingResponse.parse(
    await accessRequest(local, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["admin"] },
    }),
  );
  const paired = DeviceCredential.parse(await redeemPairing(pairing.url, "Integration device"));
  if (!daemon.remoteUrl || !daemon.fingerprint) throw new Error("Missing remote listener");
  const remote = daemon.remoteUrl.replace("wss:", "https:");
  expect(
    await accessRequest(remote, "/v1/status", {
      token: paired.token,
      fingerprint: daemon.fingerprint,
    }),
  ).toMatchObject({ running: true });
  expect(await (await call(daemon.mcp.url, lease.bearer, "ace_thread_info")).json()).toMatchObject({
    result: { structuredContent: { thread: { id: scope.threadId } } },
  });
  expect((await call(daemon.mcp.url, paired.token, "ace_thread_info")).status).toBe(401);
  await expect(
    accessRequest(remote, "/mcp", {
      token: paired.token,
      fingerprint: daemon.fingerprint,
    }),
  ).rejects.toThrow("HTTP 404");
  await daemon.close();
  expect(lease.principal.signal.aborted).toBe(true);
  expect(existsSync(endpointPath)).toBe(false);
  const reopened = await startDaemon({ config: config });
  cleanups.push(() => reopened.close());
  expect(reopened.store.devices.get(paired.device.id)).toMatchObject({
    name: "Integration device",
  });
  expect(reopened.store.getMcpAgent(scope.threadId, scope.agentId)).toMatchObject({ id: "root" });
  expect(reopened.fingerprint).toBe(daemon.fingerprint);
  expect((await call(reopened.mcp.url, lease.bearer, "ace_thread_info")).status).toBe(401);
});

it("persists an attributed notice and notification intent together and preserves pending intents across restart", async () => {
  const directory = home();
  // Exercise the durable MCP acceptance port without installing a spawn executor.
  // Full daemon composition executes legacy spawns through delegation instead.
  async function openTransport() {
    const store = new Store(join(directory, "events.sqlite"));
    const mcp = await startDaemonMcp(store);
    return {
      store,
      mcp,
      async close() {
        await mcp.close();
        store.close();
      },
    };
  }
  const daemon = await openTransport();
  cleanups.push(() => daemon.close());
  const { thread, scope } = seed(daemon.store);
  const lease = daemon.mcp.openSession(scope, new AbortController().signal);
  const response = await call(daemon.mcp.url, lease.bearer, "ace_notify_user", {
    text: "Need input",
    level: "warning",
  });
  const result: unknown = await response.json();
  expect(result).toMatchObject({ result: { structuredContent: { accepted: true } } });
  const pending = daemon.store.readMcpIntents();
  expect(pending).toMatchObject([
    {
      intent: {
        type: "mcp.notify",
        sessionId: "provider-session",
        threadId: thread.id,
        agentId: "root",
        notice: { text: "Need input", level: "warning" },
      },
    },
  ]);
  const events = daemon.store.readEvents({ threadId: thread.id, afterSeq: 0, limit: 10 });
  expect(events.at(-1)?.payload).toMatchObject({
    type: "item.created",
    item: { type: "notice", agentId: "root", text: "Need input", level: "warning", complete: true },
  });
  expect(
    await (await call(daemon.mcp.url, lease.bearer, "ace_spawn_agent", { task: "Review" })).json(),
  ).toMatchObject({ result: { structuredContent: { accepted: true } } });
  expect(daemon.store.listMcpAgents(thread.id, "", 10)).toHaveLength(1);
  await daemon.close();
  expect(lease.principal.signal.aborted).toBe(true);
  expect(() => daemon.mcp.openSession(scope, new AbortController().signal)).toThrow();
  const reopened = await openTransport();
  cleanups.push(() => reopened.close());
  expect(reopened.store.readMcpIntents()).toMatchObject([
    pending[0],
    { intent: { type: "mcp.spawn", input: { task: "Review" }, agentId: "root" } },
  ]);
  expect((await call(reopened.mcp.url, lease.bearer, "ace_thread_info")).status).toBe(401);
  const first = reopened.store.readMcpIntents()[0];
  if (!first) throw new Error("Expected pending intent");
  expect(reopened.store.acknowledgeMcpIntent(first.id)).toBe(true);
  expect(reopened.store.acknowledgeMcpIntent(first.id)).toBe(false);
  expect(reopened.store.readMcpIntents()).toHaveLength(1);
});

it("rolls back both intent and notice when event persistence fails", () => {
  const store = new Store(join(home(), "events.sqlite"));
  cleanups.push(() => store.close());
  const { thread, scope } = seed(store);
  const intent = McpNotificationIntent.parse({
    ...scope,
    type: "mcp.notify",
    notice: { text: "atomic" },
  });
  const notice: EventPayload = {
    type: "item.created",
    item: {
      type: "notice",
      id: ItemId.parse("notice"),
      agentId: scope.agentId,
      createdAt: 1,
      complete: true,
      level: "info",
      text: "atomic",
      raw: [],
    },
  };
  const before = store.headSeq();
  expect(() =>
    store.enqueueMcpIntent("rollback", intent, [notice, { type: "thread.created", thread }], 1),
  ).toThrow();
  expect(store.headSeq()).toBe(before);
  expect(store.readMcpIntents()).toEqual([]);
  store.enqueueMcpIntent("ok", intent, [notice], 1);
  expect(store.readMcpIntents()).toMatchObject([{ id: "ok" }]);
});

it("reads indexed agent pages with canonical status and late parent linkage", async () => {
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home(), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  });
  cleanups.push(() => daemon.close());
  const { thread, agent, scope } = seed(daemon.store);
  const child = Agent.parse({
    ...agent,
    id: "child",
    origin: "ace",
    status: { state: "working", activity: "tool" },
  });
  daemon.store.appendEvents(
    thread.id,
    [
      { type: "agent.created", agent: child },
      { type: "agent.updated", agentId: child.id, parentId: agent.id },
      {
        type: "agent.status",
        agentId: child.id,
        status: { state: "blocked", on: "human", refs: ["approval"] },
      },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ],
    2,
  );
  const lease = daemon.mcp.openSession(scope, new AbortController().signal);
  expect(
    await (await call(daemon.mcp.url, lease.bearer, "ace_list_agents", { limit: 1 })).json(),
  ).toMatchObject({
    result: {
      structuredContent: {
        agents: [{ id: "child", parentId: "root", status: { state: "blocked", on: "human" } }],
        nextCursor: "child",
      },
    },
  });
  expect(
    await (
      await call(daemon.mcp.url, lease.bearer, "ace_list_agents", { cursor: "child", limit: 1 })
    ).json(),
  ).toMatchObject({
    result: { structuredContent: { agents: [{ id: "root" }], nextCursor: null } },
  });
  expect(await (await call(daemon.mcp.url, lease.bearer, "ace_thread_info")).json()).toMatchObject({
    result: { structuredContent: { thread: { status: { state: "needs_you" } } } },
  });
  expect(() =>
    daemon.mcp.openSession(
      { ...scope, agentId: child.id, threadId: thread.id },
      AbortSignal.abort(),
    ),
  ).toThrow("ended");
});

it("backfills an older daemon database once and keeps indexed status live after upgrade", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(home(), "events.sqlite");
  const previous = new Store(path);
  const { thread, agent } = seed(previous);
  previous.appendEvents(
    thread.id,
    [
      {
        type: "agent.status",
        agentId: agent.id,
        status: { state: "blocked", on: "background_task", refs: ["shell"] },
      },
    ],
    2,
  );
  previous.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE mcp_agents; DROP TABLE mcp_intents; DROP TABLE mcp_meta;");
  legacy.close();
  const upgraded = new Store(path);
  cleanups.push(() => upgraded.close());
  expect(upgraded.listMcpAgents(thread.id, "", 10)).toMatchObject([
    { id: "root", status: { state: "blocked", on: "background_task" } },
  ]);
  upgraded.appendEvents(
    thread.id,
    [{ type: "agent.status", agentId: agent.id, status: { state: "idle" } }],
    3,
  );
  expect(upgraded.listMcpAgents(thread.id, "", 10)).toMatchObject([
    { id: "root", status: { state: "idle" } },
  ]);
});

it("rejects MCP intents at capacity atomically and admits work after acknowledgement", () => {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const { thread, scope } = seed(store);
  const intent = McpNotificationIntent.parse({
    ...scope,
    type: "mcp.notify",
    notice: { text: "bounded" },
  });
  for (let i = 0; i < 10000; i++) store.enqueueMcpIntent(`pending-${i}`, intent, [], 1);
  const head = store.headSeq();
  expect(() =>
    store.enqueueMcpIntent(
      "overflow",
      intent,
      [{ type: "thread.updated", title: "Must roll back" }],
      2,
    ),
  ).toThrow("capacity");
  expect(store.headSeq()).toBe(head);
  expect(store.getThread(thread.id)?.title).toBe(thread.title);
  expect(store.acknowledgeMcpIntent("pending-0")).toBe(true);
  expect(store.acknowledgeMcpIntent("pending-0")).toBe(false);
  store.enqueueMcpIntent("replacement", intent, [], 3);
  expect(() => store.enqueueMcpIntent("overflow-again", intent, [], 4)).toThrow("capacity");
  expect(store.readMcpIntents(1)[0]?.id).toBe("pending-1");
});

it("the daemon advertises unique scoped tools from every real registered toolkit", async () => {
  const directory = home();
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    nextId: () => `catalog-${++id}`,
    platform: "darwin",
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
  });
  cleanups.push(() => daemon.close());
  const { scope } = seed(daemon.store);
  const lease = daemon.mcp.openSession(
    { ...scope, capabilities: ["agents", "notify", "browser", "screen", "devices"] },
    new AbortController().signal,
  );
  const response = await fetch(daemon.mcp.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lease.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "composition", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.ok).toBe(true);
  const result = z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .parse(await response.json());
  const names = result.result.tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(
    expect.arrayContaining([
      "ace_thread_info",
      "ace_read_handoff",
      "ace_read_handoff_chunk",
      "ace_browser_open",
      "ace_browser_close",
      "ace_browser_snapshot",
      "ace_browser_screenshot",
      "screen_screenshot",
      "screen_ui_tree",
      "device_screenshot",
      "device_ui_tree",
      "device_tap",
    ]),
  );
  lease.end();
});
