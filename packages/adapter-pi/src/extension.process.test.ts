import { privateMcpConfig } from "@ace/mcp-server";
import { expect, test, onTestFinished } from "vitest";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import {
  CredentialRegistry,
  ToolRegistry,
  guideToolkit,
  nodeScheduler,
  startMcpServer,
} from "@ace/mcp-server";
import { registerAcePiExtension } from "./index.ts";
import { obj } from "./native.ts";
import { createPiExtensionHost } from "./testing/extension-host.ts";

type PiTools = ReturnType<typeof createPiExtensionHost>["tools"];
/** Pi lists ace's core tools; reading a guide opens its family, which Pi registers on refresh. */
async function openFamilies(tools: PiTools, topics: string[], expected: string[]) {
  const guide = tools.get("ace_guide");
  if (!guide) throw new Error("Missing ace_guide");
  for (const topic of topics) await guide.execute(`guide-${topic}`, { topic }, undefined);
  for (let attempt = 0; attempt < 500 && !expected.every((name) => tools.has(name)); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}
const guides = (...topics: string[]) =>
  guideToolkit(topics.map((name) => ({ name, description: name, body: `How to ${name}.` })));
test("Pi forwards scoped tools with long install deadlines, structured results and MCP errors across real HTTP", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let effect = "";
  registry.register({
    name: "echo",
    toolset: "ace-threads",
    description: "Echo",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    capability: null,
    timeoutMs: 630000,
    async run(args) {
      effect = args.value;
      return { value: `observed:${args.value}` };
    },
  });
  registry.register({
    name: "failure",
    toolset: "ace-threads",
    description: "Failure",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      throw new Error("synthetic failure");
    },
  });
  guides("ace-threads").register(registry);
  const server = await startMcpServer({ registry, credentials });
  const lease = credentials.issue(
    {
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("agent"),
      sessionId: "session",
      capabilities: [],
    },
    new AbortController().signal,
  );
  const host = createPiExtensionHost(),
    tools = host.tools;
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  onTestFinished(configuration.remove);
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    expect(host.errors).toEqual([]);
    const instructions = await host.emit("before_agent_start", {
      systemPrompt: "Pi built-in instructions",
    });
    expect(instructions).toMatchObject({
      systemPrompt: expect.stringContaining(
        "Pi built-in instructions\n\nace is the app running this session.",
      ),
    });
    expect(instructions).toMatchObject({
      systemPrompt: expect.stringContaining("guide is ace_guide"),
    });
    // echo and failure (ace_echo, ace_failure in Pi) belong to the threads family, outside Pi's core list.
    expect(tools.has("ace_echo")).toBe(false);
    await openFamilies(tools, ["ace-threads"], ["ace_echo", "ace_failure"]);
    const echo = tools.get("ace_echo"),
      failure = tools.get("ace_failure");
    if (!echo || !failure) throw new Error("Missing MCP tools");
    const result = await echo.execute("call", { value: "local-only" }, undefined);
    expect(effect).toBe("local-only");
    expect(obj(obj(result.details).aceMcp).structuredContent).toEqual({
      value: "observed:local-only",
    });
    const failed = await failure.execute("failure", {}, undefined);
    expect(obj(obj(failed.details).aceMcp).isError).toBe(true);
    const projection = await host.emit("tool_result", {
      toolName: "ace_failure",
      details: failed.details,
    });
    expect(projection).toEqual({ isError: true });
    lease.end();
    await expect(echo.execute("revoked", { value: "must not run" }, undefined)).rejects.toThrow();
    expect(effect).toBe("local-only");
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});

test("Pi executes authorized browser, screen and device tools and projects their errors", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const effects: string[] = [];
  for (const [name, capability] of [
    ["ace_browser_click", "browser"],
    ["screen_ui_act", "screen"],
    ["device_tap", "devices"],
  ] as const)
    registry.register({
      name,
      description: name,
      input: z.object({ value: z.string() }),
      output: z.object({}),
      capability,
      timeoutMs: 1000,
      async run(args) {
        effects.push(`${name}:${args.value}`);
        throw new Error("native operation rejected");
      },
    });
  guides("ace-browser", "ace-computer-use").register(registry);
  const server = await startMcpServer({ registry, credentials });
  const lease = credentials.issue(
    {
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("root"),
      sessionId: "features",
      capabilities: ["browser", "screen", "devices"],
    },
    new AbortController().signal,
  );
  const host = createPiExtensionHost(),
    tools = host.tools;
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  onTestFinished(configuration.remove);
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    await openFamilies(
      tools,
      ["ace-browser", "ace-computer-use"],
      ["ace_browser_click", "ace_screen_ui_act", "ace_device_tap"],
    );
    for (const name of ["ace_browser_click", "ace_screen_ui_act", "ace_device_tap"]) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing authorized feature tool: ${name}`);
      const result = await tool.execute("native", { value: "input" }, undefined);
      expect(await host.emit("tool_result", { toolName: name, details: result.details })).toEqual({
        isError: true,
      });
    }
    expect(effects).toEqual(["ace_browser_click:input", "screen_ui_act:input", "device_tap:input"]);
    lease.end();
    const tap = tools.get("ace_device_tap");
    if (!tap) throw new Error("No device tool");
    await expect(tap.execute("revoked", { value: "blocked" }, undefined)).rejects.toThrow();
    expect(effects).toHaveLength(3);
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});

test("Pi adds computer use when it turns on, its other tools once used, and withdraws them when it turns off, without hiding native tools", async () => {
  let enabled = false;
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  for (const name of ["screen_open_app", "screen_type"])
    registry.register({
      name,
      capability: "screen",
      description: name,
      input: z.object({}),
      output: z.object({}),
      timeoutMs: 1000,
      async run() {
        return {};
      },
    });
  const credentials = new CredentialRegistry(() => "d".repeat(64));
  const server = await startMcpServer({
    registry,
    credentials,
    status: () => ({
      access: "full-access",
      disabled: enabled ? {} : { screen: "Computer use is disabled." },
    }),
  });
  onTestFinished(() => server.close());
  const lease = credentials.issue(
    {
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("root"),
      sessionId: "pi-refresh",
      capabilities: ["screen"],
    },
    new AbortController().signal,
  );
  let changed: (() => void) | undefined;
  const host = createPiExtensionHost({
    activeTools: ["read", "bash"],
    onActiveToolsChange: () => changed?.(),
  });
  const config = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  onTestFinished(config.remove);
  onTestFinished(host.shutdown);
  await host.start((pi) => registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: config.path }));
  expect(host.errors).toEqual([]);
  expect(host.active()).toEqual(["read", "bash", "ace_context"]);
  const refresh = async (mutate: () => void) => {
    const next = Promise.withResolvers<void>();
    changed = next.resolve;
    mutate();
    server.toolsChanged();
    await next.promise;
    changed = undefined;
  };
  await refresh(() => {
    enabled = true;
  });
  // Only the entry point is listed upfront; opening an app brings the rest of computer use.
  expect(host.active()).toEqual(["read", "bash", "ace_context", "ace_screen_open_app"]);
  const open = host.tools.get("ace_screen_open_app");
  if (!open) throw new Error("Missing screen_open_app");
  const opened = Promise.withResolvers<void>();
  changed = opened.resolve;
  await open.execute("open", {}, undefined);
  await opened.promise;
  changed = undefined;
  expect(host.active()).toEqual([
    "read",
    "bash",
    "ace_context",
    "ace_screen_open_app",
    "ace_screen_type",
  ]);
  await refresh(() => {
    enabled = false;
  });
  expect(host.active()).toEqual(["read", "bash", "ace_context"]);
});

test("Pi still starts with ace's commands when ace's tool server is unreachable, reporting the failure at session start", async () => {
  const closed = await startMcpServer({
    registry: new ToolRegistry({ scheduler: nodeScheduler }),
    credentials: new CredentialRegistry(() => "e".repeat(64)),
  });
  const url = closed.url;
  await closed.close();
  const host = createPiExtensionHost({ activeTools: ["read"] });
  const config = privateMcpConfig(
    JSON.stringify({ controlSecret: "a".repeat(64), mcp: { url, bearer: "b".repeat(64) } }),
  );
  onTestFinished(config.remove);
  onTestFinished(host.shutdown);
  await host.start((pi) => registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: config.path }));
  expect(host.errors.map((error) => error.event)).toEqual(["session_start"]);
  expect([...host.commands.keys()]).toEqual(["ace-rollback", "ace-context"]);
  expect(host.active()).toEqual(["read"]);
  const context = host.commands.get("ace-context");
  if (!context) throw new Error("Missing ace context command");
  await context.handler(`${"a".repeat(64)} ${Buffer.from("settled").toString("base64")}`, {
    ui: { notify() {} },
    async waitForIdle() {},
    async navigateTree() {
      return { cancelled: true };
    },
  });
  expect(host.sent).toMatchObject([{ customType: "ace.delegation.settled", content: "settled" }]);
});

test("Pi's extension reload after switch_session or fork finds ace's session while the path stays out of the shell environment", async () => {
  const config = privateMcpConfig(JSON.stringify({ controlSecret: "a".repeat(64) }));
  onTestFinished(config.remove);
  const env: NodeJS.ProcessEnv = { ACE_PI_SESSION_FILE: config.path };
  const holder = {};
  const first = createPiExtensionHost();
  await first.start((pi) => registerAcePiExtension(pi, env, holder));
  expect(env.ACE_PI_SESSION_FILE).toBeUndefined();
  for (const replacement of ["switch_session", "fork"]) {
    // Pi shuts the old runtime down and runs every extension factory again in a new one.
    const next = createPiExtensionHost();
    await next.start((pi) => registerAcePiExtension(pi, env, holder));
    expect([...next.commands.keys()], replacement).toEqual(["ace-rollback", "ace-context"]);
  }
  expect(env.ACE_PI_SESSION_FILE).toBeUndefined();
});

test("Pi runs 80 ace tool calls at once without refusing any past a call cap", async () => {
  const registry = new ToolRegistry({
    scheduler: nodeScheduler,
    maxCalls: 256,
    maxCallsPerThread: 256,
  });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let started = 0;
  const gate = Promise.withResolvers<void>();
  registry.register({
    name: "hold",
    toolset: "ace-threads",
    description: "Hold",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    capability: null,
    timeoutMs: 30_000,
    async run(args) {
      started++;
      await gate.promise;
      return { value: args.value };
    },
  });
  guides("ace-threads").register(registry);
  const server = await startMcpServer({ registry, credentials });
  const lease = credentials.issue(
    {
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("agent"),
      sessionId: "busy",
      capabilities: [],
    },
    new AbortController().signal,
  );
  const host = createPiExtensionHost();
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  onTestFinished(configuration.remove);
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    await openFamilies(host.tools, ["ace-threads"], ["ace_hold"]);
    const hold = host.tools.get("ace_hold");
    if (!hold) throw new Error("Missing ace_hold");
    const calls = Array.from({ length: 80 }, (_, i) =>
      hold.execute(`call-${i}`, { value: String(i) }, undefined),
    );
    // Past the old cap of 16 in flight, later calls used to fail outright.
    for (let attempt = 0; attempt < 500; attempt++) {
      if (started >= 17) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    gate.resolve();
    const results = await Promise.all(calls);
    expect(results.map((result) => obj(obj(result.details).aceMcp).isError)).toEqual(
      Array.from({ length: 80 }, () => false),
    );
    expect(started).toBe(80);
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});
