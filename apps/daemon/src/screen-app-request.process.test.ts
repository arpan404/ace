import { join } from "node:path";
import { McpScope, type InteractionId } from "@ace/protocol";
import { expect, onTestFinished, test } from "vitest";
import { harness, scriptFrames, start } from "./engine/test-support.ts";
import { Result, invoke } from "./browser-mcp-test-support.ts";

/*
 * An agent asking for an app through ace's MCP server, end to end: the real engine, screen
 * service (a fake helper process), approvals and MCP HTTP endpoint. The person answers through
 * the same `interaction.resolve` command the composer strip sends.
 */
async function agentWithComputerUse() {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  onTestFinished(h.close);
  const threadId = await h.create(),
    agentId = h.engine.rootAgent(threadId);
  if (!agentId) throw new Error("Missing root");
  const [{ ScreenManager }, { startScreen }, { startMcp }, { Resources }, { createLogger }] =
    await Promise.all([
      import("@ace/screen"),
      import("./services/screen.ts"),
      import("./services/mcp.ts"),
      import("./services/resources.ts"),
      import("@ace/diagnostics"),
    ]);
  let serial = 0;
  const resources = new Resources();
  onTestFinished(() => resources.close());
  const log = createLogger({
    now: h.clock.now,
    redact: (line) => line,
    level: "silent",
    sink: { async write() {}, async close() {} },
  });
  resources.own(() => log.close());
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1" },
    nextId: () => `app-request-${++serial}`,
    recordingDirectory: join(h.home, "screen-artifacts"),
    publishArtifact: async () => {},
  });
  const context: import("./services/types.ts").ServiceContext = {
    config: {
      dataDir: h.home,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    options: { screen },
    store: h.store,
    now: h.clock.now,
    id: () => `screen-event-${++serial}`,
    log,
    resources,
    services: { engine: h.engine },
    onListen: [],
    signal: new AbortController().signal,
  };
  await startScreen(context);
  await startMcp(context);
  h.engine.bindHostInteractions((command) => context.services.screenApprovals?.resolve(command));
  onTestFinished(() => screen.close());
  await screen.enable(true);
  const mcp = context.services.mcp;
  if (!mcp) throw new Error("Missing MCP service");
  const lease = mcp.openSession(
    McpScope.parse({ sessionId: "app-request", threadId, agentId, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const connection = { url: mcp.url, bearer: lease.bearer };
  return {
    ask: async (bundleId: string) =>
      Result.parse(
        await (
          await invoke(connection, "screen_request_app", { bundleId, reason: "Check the page" })
        ).json(),
      ).result,
    /** The thread's pending request, once the call has opened it. */
    pending: async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const open = Object.values(h.store.snapshotThread(threadId).interactions).find(
          (value) => value.state === "pending",
        );
        if (open) return open;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("No pending request in the thread");
    },
    answer: (interactionId: InteractionId, optionId: string) =>
      h.command({
        type: "interaction.resolve",
        interactionId,
        resolution: { kind: "approval", optionId },
      }),
    status: () => h.store.getThread(threadId)?.status.state,
    /** Whether any app is approved for this agent's thread. */
    anyApproved: () => screen.hasAppApproval({ threadId, agentId }),
  };
}

test("an agent's Safari request waits on a pending request in the thread and Allow completes the call", async () => {
  const agent = await agentWithComputerUse();
  const call = agent.ask("com.apple.Safari");
  const request = await agent.pending();
  expect(request.request).toMatchObject({
    kind: "approval",
    target: { tool: "screen_request_app", input: { bundleId: "com.apple.Safari" } },
    // A browser is allowed for this thread at most, never always.
    options: [{ id: "allow_once" }, { id: "allow_thread" }, { id: "deny" }],
  });
  expect(agent.status()).toBe("needs_you");
  expect(agent.answer(request.id, "allow_thread").ok).toBe(true);
  const result = await call;
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
    approved: true,
    bundleId: "com.apple.Safari",
  });
});

test("Deny returns a clear denial to the agent and grants nothing", async () => {
  const agent = await agentWithComputerUse();
  const call = agent.ask("com.apple.TextEdit");
  const request = await agent.pending();
  expect(request.request).toMatchObject({
    options: [{ id: "allow_once" }, { id: "allow_thread" }, { id: "allow_always" }, { id: "deny" }],
  });
  expect(agent.answer(request.id, "deny").ok).toBe(true);
  const result = await call;
  expect(result.isError).toBe(true);
  const text = result.content[0]?.text ?? "";
  expect(text).toContain("screen_approval_denied");
  expect(text).toContain("Screen access approval denied");
  expect(text).not.toContain("Browser origin");
  expect(agent.anyApproved()).toBe(false);
});
