import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import * as sdk from "@cursor/sdk";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "@ace/adapter-cursor";
import { detectChromium } from "@ace/browser";
import { Agent } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { openCursorMcp } from "./services/cursor-mcp.ts";
import { providerFeatures } from "./testing/provider-features.ts";
import { proof } from "./testing/provider-mcp-proof.ts";
import { invoke } from "./browser-mcp-test-support.ts";

it("Cursor SDK consumes the daemon lease and calls browser, screen and device tools before any provider turn", async (test) => {
  const chromium = await detectChromium();
  if (!chromium) {
    test.skip("Chromium unavailable; no download attempted");
    return;
  }
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-tools-")));
  const f = await providerFeatures(home, chromium);
  onTestFinished(async () => {
    await f.close();
    await rm(home, { recursive: true, force: true });
  });
  const store = f.daemon.store;
  const thread = createDevThread(store, store.createWorkspace(home, "Cursor tools"));
  store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "cursor" },
        fidelity: "full",
        cwd: home,
        status: { state: "working", activity: "tool" },
        createdAt: 1,
      }),
    },
  ]);
  await f.approve(thread.id);
  const lease = await openCursorMcp(
    {
      store,
      services: {
        mcp: f.daemon.mcp,
        browser: f.daemon.browser,
        screen: f.screen,
        devices: f.devices,
      },
      id: () => "cursor-tools",
    },
    {
      instanceId: "test",
      threadId: thread.id,
      cwd: home,
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    },
  );
  const boundary: RuntimeSdkBoundary = {
    JsonlLocalAgentStore: sdk.JsonlLocalAgentStore,
    AuthenticationError: sdk.AuthenticationError,
    RateLimitError: sdk.RateLimitError,
    NetworkError: sdk.NetworkError,
    Cursor: {
      auth: { status: async () => ({ status: "logged-in", backendUrl: "http://127.0.0.1" }) },
    },
    Agent: {
      async create(options) {
        const server = z
          .object({
            type: z.literal("http"),
            url: z.string(),
            headers: z.object({ Authorization: z.string() }),
          })
          .parse(options.mcpServers?.ace);
        expect(JSON.stringify(process.env)).not.toContain(server.headers.Authorization.slice(7));
        expect(
          await proof(server.url, server.headers.Authorization, {
            url: f.browserUrl,
            deviceId: f.deviceId,
          }),
        ).toBe(thread.id);
        return {
          agentId: "fake-sdk",
          async [Symbol.asyncDispose]() {},
          async send() {
            throw new Error("Provider prompts are forbidden in this test");
          },
        };
      },
      async resume() {
        throw new Error("Unexpected resume");
      },
      async cancelRun() {},
    },
  };
  const host = new HostRuntime(
    boundary,
    async () => {},
    () => home,
    {},
  );
  try {
    await host.open({
      threadId: thread.id,
      generation: "cursor-host",
      cwd: home,
      policy: "full-access",
      limits: CursorLimitsSchema.parse({}),
      mcp: lease.connection,
    });
    expect(await f.effects(thread.id)).toEqual({
      browser: "provider-input",
      screen: '{"ref":"save","action":"press"}\n',
      device: expect.stringContaining("'input' 'tap' '3' '4'"),
    });
  } finally {
    await host.close();
    lease.end();
  }
  expect(() => f.screen.agentSession({ threadId: thread.id, agentId: "root" })).toThrow(
    "delegation required",
  );
  expect((await invoke(lease.connection, "ace_browser_open", {})).status).toBe(401);
});
