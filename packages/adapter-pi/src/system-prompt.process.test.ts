import { expect, test, onTestFinished } from "vitest";
import { randomBytes } from "node:crypto";
import { AgentId, ThreadId } from "@ace/protocol";
import {
  CredentialRegistry,
  ToolRegistry,
  nodeScheduler,
  privateMcpConfig,
  startMcpServer,
  type AwarenessPort,
} from "@ace/mcp-server";
import { registerAcePiExtension } from "./index.ts";
import { createPiExtensionHost } from "./testing/extension-host.ts";

type Facts = NonNullable<ReturnType<AwarenessPort["facts"]>>;

test("Pi's first turn carries the session brief and its system prompt stays the same while live counts change", async () => {
  const facts: Facts = {
    project: "ace",
    branch: "main",
    worktree: false,
    machine: null,
    access: "full-access",
    liveSiblings: 0,
    children: [],
    pendingRequests: 0,
    notes: [],
  };
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const server = await startMcpServer({
    registry: new ToolRegistry({ scheduler: nodeScheduler }),
    credentials,
    awareness: { facts: () => ({ ...facts }), delegates: () => [] },
  });
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
  const turn = async () =>
    JSON.stringify(await host.emit("before_agent_start", { systemPrompt: "Pi built-in" }));
  try {
    await host.start((pi) =>
      registerAcePiExtension(pi, { ACE_PI_SESSION_FILE: configuration.path }),
    );
    const first = await turn();
    expect(first).toContain('Project \\"ace\\"');
    Object.assign(facts, {
      liveSiblings: 4,
      pendingRequests: 2,
      children: [{ id: "child-1", label: "Build", state: "working" }],
    });
    // Pi used to refresh its copy after each turn; give a background read time to land.
    await turn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await turn()).toBe(first);
  } finally {
    await host.shutdown();
    lease.end();
    await server.close();
  }
});
