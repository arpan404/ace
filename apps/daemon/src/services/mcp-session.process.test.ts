import { afterEach, expect, it } from "vitest";
import { Agent, AgentId, Capabilities, Command } from "@ace/protocol";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { Store } from "../store.ts";
import { createDevThread, startDaemon, readConfig, AdapterRegistry } from "../index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonMcp } from "../mcp.ts";
import { bindMcpSession } from "./mcp-session.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup() {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/test", "Test"));
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
  const mcp = await startDaemonMcp(store);
  cleanup.push(() => mcp.close());
  const controller = new AbortController();
  const context: SessionContext = {
    threadId: thread.id,
    cwd: "/test",
    signal: controller.signal,
    onFrame() {},
    onExit() {},
  };
  const scripted = createScriptedAdapter({
    provider: "codex",
    steps: [],
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: false,
      backgroundTaskControl: false,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
  });
  let nativeContext: SessionContext | undefined;
  const adapter = {
    ...scripted,
    async openSession(ctx: SessionContext) {
      nativeContext = ctx;
      return scripted.openSession(ctx);
    },
  };
  let seq = 0;
  const open = () =>
    bindMcpSession(adapter, context, {
      mcp,
      store,
      id: () => `session-${++seq}`,
      capabilities: ["notify", "agents"],
    });
  const native = () => {
    if (!nativeContext?.aceMcp) throw new Error("Missing injected MCP connection");
    return nativeContext;
  };
  async function read(ctx = native()) {
    if (!ctx.aceMcp) throw new Error("Missing credential");
    return fetch(ctx.aceMcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.aceMcp.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "ace_thread_info",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ace_thread_info",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }
  return { adapter, context, controller, store, thread, mcp, open, native, read };
}
it("injects a live thread-scoped connection and revokes it on provider exit", async () => {
  const h = await setup();
  const session = await h.open();
  cleanup.push(() => session.close("shutdown"));
  expect(await (await h.read()).json()).toMatchObject({
    result: { structuredContent: { thread: { id: h.thread.id, rootAgentId: "root" } } },
  });
  h.native().onExit({ deliberate: false });
  expect((await h.read()).status).toBe(401);
});
it("revokes credentials before closing even when provider close fails", async () => {
  const h = await setup();
  const original = h.adapter.openSession;
  h.adapter.openSession = async (ctx) => ({
    ...(await original(ctx)),
    close: async () => {
      throw new Error("close failed");
    },
  });
  const session = await h.open();
  await expect(session.close("user")).rejects.toThrow("close failed");
  expect((await h.read()).status).toBe(401);
});
it("revokes credentials when opening fails and issues a fresh credential on retry", async () => {
  const h = await setup();
  const original = h.adapter.openSession;
  h.adapter.openSession = async (ctx) => {
    await original(ctx);
    throw new Error("open failed");
  };
  await expect(h.open()).rejects.toThrow("open failed");
  const failed = h.native();
  expect((await h.read(failed)).status).toBe(401);
  h.adapter.openSession = original;
  const session = await h.open();
  cleanup.push(() => session.close("shutdown"));
  expect((await h.read()).status).toBe(200);
  expect((await h.read(failed)).status).toBe(401);
});
it("revokes on the engine lifetime ending without waiting for provider exit", async () => {
  const h = await setup();
  const session = await h.open();
  cleanup.push(() => session.close("shutdown"));
  h.controller.abort();
  expect((await h.read()).status).toBe(401);
});

it("daemon composition gives lazy engine sessions scoped MCP authority before provider startup", async () => {
  const h = await setup();
  const directory = await mkdtemp(join(tmpdir(), "ace-engine-mcp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new AdapterRegistry();
  registry.register(h.adapter, { installed: true, auth: "logged_in", loginHint: "offline" });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: { registry },
  });
  cleanup.push(() => daemon.close());
  const engine = daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const command = Command.parse({
    id: "create",
    deviceId: "human",
    payload: {
      type: "thread.create",
      workspaceId: daemon.store.createWorkspace(directory, "MCP"),
      provider: "codex",
      input: [{ type: "text", text: "offline scripted input" }],
    },
  });
  expect(
    daemon.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, daemon.store),
    ),
  ).toHaveProperty("ok", true);
  await engine.flush();
  const thread = daemon.store.listThreads()[0];
  if (!thread?.rootAgentId) throw new Error("Missing engine root");
  expect(await (await h.read()).json()).toMatchObject({
    result: {
      structuredContent: {
        thread: { id: thread.id, rootAgentId: thread.rootAgentId },
      },
    },
  });
  const caller = h.native();
  await daemon.close();
  // The isolated listener has shut down, so a closed session cannot reach tools.
  await expect(h.read(caller)).rejects.toThrow();
});

it("session MCP binding preserves effective selectors and provider MCP controls", async () => {
  const h = await setup();
  let model = "initial";
  let mode = "code";
  let servers: Record<string, unknown> = {};
  let resume = false;
  const original = h.adapter.openSession;
  h.adapter.openSession = async (context) => ({
    ...(await original(context)),
    get effectiveCapabilities() {
      return {
        ...h.adapter.capabilities({ installed: true, auth: "unknown", loginHint: "offline" }),
        resume,
      };
    },
    async setModel(value) {
      model = value;
      resume = true;
    },
    async setMode(value) {
      mode = value;
    },
    mcp: {
      async status() {
        return { model, mode, servers };
      },
      async replace(value) {
        servers = value;
        return { servers };
      },
      async reconnect() {},
      async enable() {},
      async disable() {},
    },
  });
  const session = await h.open();
  cleanup.push(() => session.close("shutdown"));
  expect(session.effectiveCapabilities?.resume).toBe(false);
  await session.setModel?.("selected");
  await session.setMode?.("plan");
  await session.mcp?.replace({ local: { command: "user-mcp" } });
  expect(await session.mcp?.status()).toEqual({
    model: "selected",
    mode: "plan",
    servers: { local: { command: "user-mcp" } },
  });
  expect(session.effectiveCapabilities?.resume).toBe(true);
});

it("a negotiated ACP lease retains its caller and ends without issuing a duplicate lease", async () => {
  const h = await setup();
  const lifetime = new AbortController();
  const existing = h.mcp.openSession(
    {
      sessionId: "negotiated",
      threadId: h.thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["agents"],
    },
    lifetime.signal,
  );
  const connection = { url: h.mcp.url, bearer: existing.bearer };
  const context = {
    ...h.context,
    mcp: { httpServers: [], stdioServers: [], secrets: [existing.bearer], end: existing.end },
  };
  const session = await bindMcpSession(h.adapter, context, {
    mcp: h.mcp,
    store: h.store,
    capabilities: ["agents"],
    id() {
      throw new Error("A second lease would replace the ACP negotiated caller");
    },
  });
  const query = { ...h.context, aceMcp: connection };
  expect((await h.read(query)).status).toBe(200);
  await session.close("shutdown");
  expect((await h.read(query)).status).toBe(401);
});
