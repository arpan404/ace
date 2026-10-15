import { expect, test } from "vitest";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import { opencodeNative } from "@ace/provider-kit/access-modes";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "@ace/mcp-server";
import type { SessionContext } from "@ace/engine-api";
import { createOpenCodeAdapter } from "./index.ts";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

const Rule = z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(["allow", "ask", "deny"]),
});
/** OpenCode's documented evaluation: the last rule whose action pattern matches wins. */
function effect(rules: z.infer<typeof Rule>[], tool: string) {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(
      tool,
    );
  return rules.findLast((rule) => rule.resource === "*" && matches(rule.action))?.effect;
}
// The person's own OpenCode configuration: rules, an agent and an MCP server of theirs.
const userConfig = {
  permission: { shell: { "git push *": "ask" } },
  agent: { reviewer: { description: "Reviews diffs", mode: "subagent" } },
  mcp: { servers: { user: { type: "remote", url: "https://example.invalid" } } },
};

async function openFullAccess() {
  const credentials = new CredentialRegistry(() => "f".repeat(64));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  registry.register({
    name: "ace_scope",
    description: "Observe authority",
    capability: "thread_control",
    timeoutMs: 1000,
    input: z.object({}),
    output: z.object({ threadId: ThreadId }),
    async run(_input, context) {
      return { threadId: context.caller.threadId };
    },
  });
  const mcp = await startMcpServer({ registry, credentials });
  const h = await setup();
  const adapter = createOpenCodeAdapter(h.options);
  const controller = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "native-tools",
      threadId: ThreadId.parse("thread-native"),
      agentId: AgentId.parse("agent-native"),
      capabilities: ["thread_control"],
    },
    controller.signal,
  );
  const context: SessionContext = {
    threadId: ThreadId.parse("thread-native"),
    cwd: "/native",
    permissionMode: opencodeNative.fullAccess,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig) },
    signal: new AbortController().signal,
    aceMcp: { url: mcp.url, bearer: lease.bearer, signal: lease.principal.signal, end: lease.end },
    onFrame() {},
    onExit() {},
  };
  const session = await adapter.openSession(context);
  return {
    h,
    session,
    async close() {
      await session.close("shutdown");
      await adapter.close();
      controller.abort();
      await mcp.close();
    },
  };
}

test("a Full access OpenCode session keeps every native tool: shell, read, edit, write, grep, glob, list, webfetch and the rest", async () => {
  const { h, session, close } = await openFullAccess();
  try {
    const info = object(object(await h.control(`/api/session/${session.nativeSessionId}`)).data);
    expect(info.agent).toBe("build");
    const rules = z.array(Rule).parse(info.permissions);
    for (const tool of [
      "shell",
      "read",
      "edit",
      "write",
      "patch",
      "grep",
      "glob",
      "list",
      "webfetch",
      "websearch",
      "subagent",
      "skill",
      "todowrite",
      "question",
      "external_directory",
    ])
      expect({ tool, effect: effect(rules, tool) }).toEqual({ tool, effect: "allow" });
    expect(rules.some((rule) => rule.effect !== "allow")).toBe(false);
  } finally {
    await close();
  }
});

test("ace adds its MCP server and readiness plugin to OpenCode and leaves the person's own configuration untouched", async () => {
  const { h, close } = await openFullAccess();
  try {
    const { plugins, ...rest } = object(await h.control("/test/configuration"));
    expect(rest).toEqual(userConfig);
    expect(array(plugins)).toHaveLength(1);
    expect(object(await h.control("/test/mcp"))).toMatchObject({ names: ["user", "ace"] });
    const requests = array(await h.control("/test/requests")).map(object);
    const create = requests.find((r) => r.path === "/api/session" && r.method === "POST");
    // OpenCode's own Build agent runs; ace defines no agent, tool map or system prompt for it.
    const body = object(create?.body);
    expect(body.agent).toBe("build");
    for (const key of ["tools", "system", "agents", "instructions"])
      expect(body).not.toHaveProperty(key);
  } finally {
    await close();
  }
});

test("OpenCode is told its own tools are direct tools beside ace's, outside Code Mode's catalog", async () => {
  const { h, session, close } = await openFullAccess();
  try {
    const guidance = String(
      object(
        object(object(await h.control(`/api/session/${session.nativeSessionId}`)).data)
          .instructions,
      )["ace.tool-guidance"],
    );
    const native = guidance.split("\n")[0] ?? "";
    for (const tool of ["read", "write", "edit", "shell", "grep", "glob", "webfetch"])
      expect(native).toContain(tool);
    expect(guidance).toContain("never through execute");
    expect(guidance).toContain("never replace them");
  } finally {
    await close();
  }
});
