/*
 * A real daemon whose browser fails its first start and recovers on a retry: the services that
 * started without it (MCP's tools) must pick it up. Needs the real startup order and retry
 * schedule, which a unit test of one service can't stand in for.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, McpScope } from "@ace/protocol";
import { createDevThread, readConfig, startDaemon } from "./index.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function toolNames(url: string, bearer: string): Promise<string[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
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
          "io.modelcontextprotocol/clientInfo": { name: "browser-recovery-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  const listed = z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .parse(await response.json());
  return listed.result.tools.map((tool) => tool.name);
}

it("a browser that recovers on a startup retry gives agents the browser tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-recovery-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const config = readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" });
  let failed = false;
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config,
    startup: {
      retryDelaysMs: [300, 300, 300],
      // The browser's first start runs past its deadline at once, as a stuck start would.
      schedule(name, expire, milliseconds) {
        if (name === "browser" && !failed) {
          failed = true;
          queueMicrotask(expire);
          return () => {};
        }
        const timer = setTimeout(expire, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  cleanups.push(() => daemon.close());
  const browserState = () => daemon.serviceStatus().find((s) => s.name === "browser")?.state;
  expect(browserState()).toBe("degraded");

  const workspace = daemon.store.createWorkspace(home, "Repo");
  const thread = createDevThread(daemon.store, workspace);
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: home,
    status: { state: "idle" },
    createdAt: 1,
  });
  daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  const lease = daemon.mcp.openSession(
    McpScope.parse({
      sessionId: "provider-session",
      threadId: thread.id,
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  const before = await toolNames(daemon.mcp.url, lease.bearer);
  expect(before).not.toContain("browser_open");
  expect(before).not.toContain("browser_request_help");

  // The retry comes 300ms after the daemon listens.
  await expect.poll(browserState, { timeout: 10_000, interval: 50 }).toBe("ready");

  expect(await toolNames(daemon.mcp.url, lease.bearer)).toEqual(
    expect.arrayContaining(["browser_open", "browser_snapshot", "browser_request_help"]),
  );
});
