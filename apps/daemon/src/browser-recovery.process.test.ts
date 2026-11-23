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

async function rpc(url: string, bearer: string, method: string, params: object = {}) {
  const name = "name" in params && typeof params.name === "string" ? params.name : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "browser-recovery-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  return z.object({ result: z.record(z.string(), z.unknown()) }).parse(await response.json())
    .result;
}

async function toolNames(url: string, bearer: string): Promise<string[]> {
  const listed = z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .parse(await rpc(url, bearer, "tools/list"));
  return listed.tools.map((tool) => tool.name);
}

/** A tool call's outcome: whether it failed, and its text. */
async function call(url: string, bearer: string, name: string, args: object = {}) {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .parse(await rpc(url, bearer, "tools/call", { name, arguments: args }));
  return {
    failed: result.isError === true,
    text: result.content.map((part) => part.text ?? "").join("\n"),
  };
}

it("browser tools stay listed while the browser is down, and work once a retry brings it up", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-recovery-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const config = readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" });
  let failed = false;
  // The browser's first retry waits for the test, so the first calls surely meet no browser.
  const retry = Promise.withResolvers<void>();
  let gated = true;
  // The failed attempt is over, its start and cleanup included: a retry then really runs.
  const failedAttemptOver = Promise.withResolvers<void>();
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config,
    startup: {
      retryDelaysMs: [10, 10, 10],
      onAttempt(name, running) {
        if (name === "browser" && !running) failedAttemptOver.resolve();
      },
      // The browser's first start runs past its deadline at once, as a stuck start would.
      schedule(name, expire, milliseconds) {
        if (name === "browser" && !failed) {
          failed = true;
          queueMicrotask(expire);
          return () => {};
        }
        if (name === "retry browser" && gated) {
          gated = false;
          let live = true;
          void retry.promise.then(() => live && expire());
          return () => void (live = false);
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
  // Clients that keep the list a session first got (Codex, Cursor) still find the tools.
  const listed = ["browser_open", "browser_settings", "browser_snapshot", "browser_request_help"];
  expect(await toolNames(daemon.mcp.url, lease.bearer)).toEqual(expect.arrayContaining(listed));
  const down = await call(daemon.mcp.url, lease.bearer, "browser_settings", { action: "close" });
  expect(down.failed).toBe(true);
  expect(down.text).toContain("browser_unavailable");

  await failedAttemptOver.promise;
  retry.resolve();
  await expect.poll(browserState, { timeout: 10_000, interval: 20 }).toBe("ready");

  expect(await toolNames(daemon.mcp.url, lease.bearer)).toEqual(expect.arrayContaining(listed));
  const up = await call(daemon.mcp.url, lease.bearer, "browser_settings", { action: "close" });
  expect(up.text).not.toContain("browser_unavailable");
  expect(up.failed).toBe(false);
});
