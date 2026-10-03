import { expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "@ace/mcp-server";
import { registerAcePiExtension, type PiExtensionApi } from "./index.ts";
import { obj } from "./native.ts";
test("Pi extension forwards scoped tools, structured results and MCP errors across real HTTP", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let effect = "";
  registry.register({
    name: "ace_echo",
    description: "Echo",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    capability: null,
    timeoutMs: 1000,
    async run(args) {
      effect = args.value;
      return { value: `observed:${args.value}` };
    },
  });
  registry.register({
    name: "ace_failure",
    description: "Failure",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      throw new Error("synthetic failure");
    },
  });
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
  const tools = new Map<string, Parameters<PiExtensionApi["registerTool"]>[0]>(),
    hooks = new Map<string, unknown>();
  const pi: PiExtensionApi = {
    appendEntry() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: unknown) {
      hooks.set(event, handler);
    },
  };
  try {
    await registerAcePiExtension(pi, {
      ACE_PI_CONTROL_SECRET: "a".repeat(64),
      ACE_PI_MCP_URL: server.url,
      ACE_PI_MCP_BEARER: lease.bearer,
    });
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
    const hook = hooks.get("tool_result");
    if (typeof hook !== "function") throw new Error("Missing result hook");
    const projection: unknown = Reflect.apply(hook, undefined, [
      { toolName: "ace_failure", details: failed.details },
    ]);
    expect(projection).toEqual({ isError: true });
    lease.end();
    await expect(echo.execute("revoked", { value: "must not run" }, undefined)).rejects.toThrow();
    expect(effect).toBe("local-only");
  } finally {
    const shutdown = hooks.get("session_shutdown");
    if (typeof shutdown === "function") await Reflect.apply(shutdown, undefined, []);
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
  const tools = new Map<string, Parameters<PiExtensionApi["registerTool"]>[0]>();
  let shutdown: (() => Promise<void>) | undefined;
  let project: ((event: { toolName: string; details: unknown }) => unknown) | undefined;
  const pi: PiExtensionApi = {
    appendEntry() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      if (event === "session_shutdown") shutdown = () => Reflect.apply(handler, undefined, []);
      else project = (result) => Reflect.apply(handler, undefined, [result]);
    },
  };
  try {
    await registerAcePiExtension(pi, {
      ACE_PI_CONTROL_SECRET: "a".repeat(64),
      ACE_PI_MCP_URL: server.url,
      ACE_PI_MCP_BEARER: lease.bearer,
    });
    for (const name of ["ace_browser_click", "screen_ui_act", "device_tap"]) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing authorized feature tool: ${name}`);
      const result = await tool.execute("native", { value: "input" }, undefined);
      expect(project?.({ toolName: name, details: result.details })).toEqual({ isError: true });
    }
    expect(effects).toEqual(["ace_browser_click:input", "screen_ui_act:input", "device_tap:input"]);
    lease.end();
    const tap = tools.get("device_tap");
    if (!tap) throw new Error("No device tool");
    await expect(tap.execute("revoked", { value: "blocked" }, undefined)).rejects.toThrow();
    expect(effects).toHaveLength(3);
  } finally {
    await shutdown?.();
    lease.end();
    await server.close();
  }
});
