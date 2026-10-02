import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AgentId, McpScope, Thread, ThreadId } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "./index.ts";
import type { Scheduler } from "./index.ts";

export function deferred<T>() {
  const pending = Promise.withResolvers<T>();
  return pending;
}

export const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  title: "Test",
  provider: "codex",
  status: { state: "waiting", on: "background_task" },
  createdAt: 1,
  updatedAt: 1,
});
export function scope(agentId = "root", capabilities: McpScope["capabilities"] = []): McpScope {
  return {
    sessionId: `session-${agentId}`,
    threadId: ThreadId.parse("thread"),
    agentId: AgentId.parse(agentId),
    capabilities,
  };
}
export async function harness(
  cleanups: (() => void | Promise<void>)[],
  scheduler: Scheduler = nodeScheduler,
) {
  const registry = new ToolRegistry({ scheduler });
  const credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const server = await startMcpServer({ registry, credentials });
  cleanups.push(() => server.close());
  async function connect(input = scope(), mode: "modern" | "legacy" = "modern") {
    const lifetime = new AbortController();
    const lease = credentials.issue(input, lifetime.signal);
    const client = new Client(
      { name: "test", version: "1" },
      { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
    );
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
      }),
    );
    return { client, lease, lifetime };
  }
  return { registry, credentials, server, connect };
}
