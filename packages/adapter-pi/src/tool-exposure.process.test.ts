import { expect, test, onTestFinished } from "vitest";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentId, ThreadId } from "@ace/protocol";
import { piNative } from "@ace/provider-kit/access-modes";
import {
  CredentialRegistry,
  ToolRegistry,
  guideToolkit,
  nodeScheduler,
  privateMcpConfig,
  startMcpServer,
} from "@ace/mcp-server";
import { registerAcePiExtension } from "./index.ts";
import { piLaunchArgs } from "./launch-args.ts";
import { obj } from "./native.ts";
import { createPiExtensionHost } from "./testing/extension-host.ts";

/** The `--tools` allowlist ace launches Pi with for a mode. */
function allowlist(mode: string): string[] {
  const args = piLaunchArgs(mode, undefined);
  return (args[args.indexOf("--tools") + 1] ?? "").split(",");
}

test("read-only Pi can call ace's read tools under its tool allowlist and is never offered a write", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let delegated = false;
  registry.register({
    name: "delegate",
    description: "Start child agents.",
    riskClass: "agent-execution",
    input: z.object({}),
    output: z.object({}),
    capability: null,
    timeoutMs: 1000,
    async run() {
      delegated = true;
      return {};
    },
  });
  guideToolkit([{ name: "ace-agents", description: "agents", body: "How to delegate." }]).register(
    registry,
  );
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
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
      readOnly: true,
    }),
  );
  onTestFinished(configuration.remove);
  const host = createPiExtensionHost({
    activeTools: ["read", "grep", "find", "ls"],
    allowedTools: allowlist(piNative.readOnly),
  });
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    expect(host.errors).toEqual([]);
    const context = host.tools.get("ace_context");
    const guide = host.tools.get("ace_guide");
    if (!context || !guide) throw new Error(`ace read tools missing: ${host.active().join(",")}`);
    const status = await context.execute("context", { topics: ["status"] }, undefined);
    expect(obj(obj(status.details).aceMcp).isError).toBe(false);
    const read = await guide.execute("guide", { topic: "ace-agents" }, undefined);
    expect(JSON.stringify(read.content)).toContain("How to delegate.");
    expect(host.active()).toEqual(expect.arrayContaining(["read", "ace_context", "ace_guide"]));
    expect(host.tools.has("ace_delegate")).toBe(false);
    expect(host.tools.has("ace_tools_call")).toBe(false);
    expect(delegated).toBe(false);
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});

test("ace's tools add nothing to Pi's system prompt tool list, so their descriptions are sent once", async () => {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  guideToolkit([{ name: "ace-agents", description: "agents", body: "How to delegate." }]).register(
    registry,
  );
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
  const configuration = privateMcpConfig(
    JSON.stringify({
      controlSecret: "a".repeat(64),
      mcp: { url: server.url, bearer: lease.bearer },
    }),
  );
  onTestFinished(configuration.remove);
  const host = createPiExtensionHost();
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    expect(host.tools.has("ace_guide")).toBe(true);
    expect(host.promptToolLines()).toEqual([]);
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});
