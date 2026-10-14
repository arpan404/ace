import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { Agent, McpScope } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import { createDevThread, readConfig, startDaemon } from "./index.ts";
import { invoke } from "./browser-mcp-test-support.ts";
import { ScreenSettings } from "./screen-settings.ts";

const Reply = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  }),
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-screen-agent-access-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper-behavior.ts", import.meta.url)
        .pathname,
    ],
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
    modelInstances: [],
    history: { instances: [] },
  });
  onTestFinished(() => daemon.close());
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "Computer use"));
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "claude" },
    fidelity: "full",
    cwd: home,
    status: { state: "idle" },
    createdAt: 1,
  });
  daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  const lease = daemon.mcp.openSession(
    McpScope.parse({
      sessionId: "computer-use",
      threadId: thread.id,
      agentId: agent.id,
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    Reply.parse(
      await (await invoke({ url: daemon.mcp.url, bearer: lease.bearer }, name, args)).json(),
    ).result;
  return { daemon, screen, thread, call };
}

it("an agent opens, types into and foregrounds an app through daemon MCP without any prompt", async () => {
  const f = await fixture();
  await f.screen.enable(true);
  for (const [name, args] of [
    ["screen_open_app", { bundleId: "com.apple.Safari" }],
    ["screen_type", { text: "release notes" }],
    ["screen_request_foreground", {}],
  ] as const) {
    const result = await f.call(name, args);
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
  }
  // Nothing waited on the person: the provider's own permission mode governed each call.
  expect(f.daemon.store.snapshotThread(f.thread.id).interactions).toEqual({});
  expect(f.screen.states()).toMatchObject([
    {
      target: { bundleId: "com.apple.Safari" },
      controller: "agent",
      holder: { threadId: f.thread.id, agentId: "root" },
      mode: "foreground",
    },
  ]);
  // Taking control is still the person's: the agent is refused until they hand it back.
  const [session] = f.screen.states();
  if (!session) throw new Error("Missing agent session");
  f.screen.controller(session.sessionId, "human", "person");
  expect((await f.call("screen_type", { text: "blocked" })).isError).toBe(true);
});

it("the person's computer use switch is stored, and Stop all turns it off for agents", async () => {
  const f = await fixture();
  const settings = new ScreenSettings(f.daemon.store);
  expect(settings.enabled()).toBe(false);
  await f.screen.enable(true);
  expect(settings.enabled()).toBe(true);
  await f.screen.stopAll();
  expect(settings.enabled()).toBe(false);
  expect((await f.call("screen_open_app", { bundleId: "com.apple.TextEdit" })).isError).toBe(true);
});
