import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import * as sdk from "@cursor/sdk";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createPiAdapter } from "@ace/adapter-pi";
import { HostRuntime, CursorLimitsSchema, type RuntimeSdkBoundary } from "@ace/adapter-cursor";
import type { ProviderAdapter } from "@ace/engine-api";
import { Agent, AgentId } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { bindMcpSession } from "./services/mcp-session.ts";
import { availability } from "./testing/provider-mcp-availability.ts";

async function setup(provider: "claude" | "codex" | "opencode" | "pi" | "cursor") {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-availability-"));
  const store = new Store(join(home, "events.db"));
  const mcp = await startDaemonMcp(store);
  onTestFinished(async () => {
    await mcp.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const thread = createDevThread(store, store.createWorkspace(home, "Discovery"));
  store.appendEvents(
    thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: "root",
          threadId: thread.id,
          parentId: null,
          origin: "root",
          native: { provider },
          fidelity: "full",
          cwd: home,
          status: { state: "idle" },
          createdAt: 1,
        }),
      },
    ],
    1,
  );
  return { home, store, mcp, thread };
}

for (const provider of ["claude", "codex", "opencode", "pi"] as const)
  it(`${provider} can discover instructions and read ace status through its delivered session authority`, async () => {
    const { home, store, mcp, thread } = await setup(provider);
    const binary = join(home, provider);
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.env.ACE_TEST_PROVIDER=${JSON.stringify(provider)}; await import(${JSON.stringify(new URL("./testing/mcp-provider.ts", import.meta.url).href)});\n`,
      { mode: 0o700 },
    );
    await chmod(binary, 0o700);
    const adapter: ProviderAdapter & { close?(): Promise<void> } =
      provider === "claude"
        ? createClaudeAdapter({ executable: binary })
        : provider === "codex"
          ? createCodexAdapter({ discovery: { overrides: { codex: binary } } })
          : provider === "opencode"
            ? createOpenCodeAdapter({ discovery: { overrides: { opencode: binary } } })
            : createPiAdapter({ executable: binary });
    onTestFinished(() => adapter.close?.());
    const observed = Promise.withResolvers<string>();
    void observed.promise.catch(() => {});
    const frames: string[] = [];
    const session = await bindMcpSession(
      adapter,
      {
        threadId: thread.id,
        cwd: home,
        env: { PATH: home },
        signal: new AbortController().signal,
        onExit(exit) {
          observed.reject(new Error(exit.message ?? "Provider exited before discovery"));
        },
        onFrame(frame) {
          const text = JSON.stringify(frame.data);
          frames.push(text);
          if (text.includes('"mcpProof":')) observed.resolve(text);
        },
      },
      { mcp, store, id: () => "availability-session", capabilities: [] },
    );
    expect(await observed.promise).toContain(thread.id);
    expect(frames.join("\n")).not.toMatch(/[a-f0-9]{64}/);
    await session.close("shutdown");
  });

it("Cursor's scripted SDK receives ace status, its resource and instructions without a model turn", async () => {
  const { home, mcp, thread } = await setup("cursor");
  const lease = mcp.openSession(
    {
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      sessionId: "cursor-discovery",
      capabilities: [],
    },
    new AbortController().signal,
  );
  let result: Awaited<ReturnType<typeof availability>> | undefined;
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
        result = await availability(server.url, server.headers.Authorization);
        return {
          agentId: "scripted",
          async [Symbol.asyncDispose]() {},
          async send() {
            throw new Error("Live prompts are forbidden");
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
  onTestFinished(async () => {
    await host.close();
    lease.end();
  });
  await host.open({
    threadId: thread.id,
    generation: "discovery",
    cwd: home,
    policy: "full-access",
    limits: CursorLimitsSchema.parse({}),
    mcp: { url: mcp.url, bearer: lease.bearer },
  });
  expect(result).toMatchObject({
    threadId: thread.id,
    agentId: AgentId.parse("root"),
    resources: [{ uri: "ace://status" }],
    instructions: expect.stringContaining("ace_status"),
  });
});
