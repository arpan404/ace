import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, Command, DeviceId, type CommandPayload } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Client } from "./socket-test-support.ts";
import { end, ManualClock, scriptFrames, start, until } from "./engine/test-support.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).toReversed()) await close();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("daemon composition applies a fork's patch through git and supplies browser MCP tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-composition-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("ACE_ACCOUNTS_DB", join(home, "accounts.sqlite"));
  vi.stubEnv("ACE_MAINTENANCE", "0");
  await promisify(execFile)("git", ["init", home]);
  await writeFile(join(home, "file.txt"), "before\n");
  const frames = scriptFrames();
  const registry = new AdapterRegistry();
  registry.register(
    createScriptedAdapter({
      provider: "codex",
      capabilities: Capabilities.parse({
        steer: false,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: true,
        backgroundTaskControl: false,
        backgroundVisibility: "full",
        planMode: false,
        tokenUsage: false,
        imageInput: false,
        rewindFiles: false,
      }),
      createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
      steps: [
        {
          on: "send",
          frames: [
            frames.frame(
              start,
              {
                type: "item.upsert",
                agent: "root",
                item: "answer",
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: true,
                  parts: [{ type: "text", text: "Ready to merge" }],
                },
              },
              end,
            ),
          ],
        },
      ],
    }),
    { installed: true, auth: "logged_in", loginHint: "synthetic" },
  );
  cleanups.push(() => registry.close());
  const errors: unknown[] = [];
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    history: { instances: [] },
    modelInstances: [],
    engine: { registry, clock: new ManualClock(), onError: (error) => errors.push(error) },
  });
  cleanups.push(() => daemon.close());
  const engine = daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const client = new Client(daemon.url);
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("composition-test"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  let serial = 0;
  async function command(payload: CommandPayload) {
    const value = Command.parse({
      id: `command-${++serial}`,
      deviceId: "composition-test",
      payload,
    });
    client.send({ type: "command", command: value });
    const reply = await until(
      client,
      (message) => message.type === "commandResult" && message.commandId === value.id,
    );
    if (reply.type !== "commandResult") throw new Error("Missing command receipt");
    expect(reply.ok).toBe(true);
    await engine?.flush();
    return reply;
  }
  const workspace = daemon.store.createWorkspace(home, "Composition");
  await command({
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "Start source" }],
  });
  const source = daemon.store.listThreads()[0];
  if (!source) throw new Error("Missing source thread");
  const sourceRun = Object.values(daemon.store.snapshotThread(source.id).runs)[0];
  if (!sourceRun) throw new Error("Missing source run");
  const fork = await command({
    type: "thread.fork",
    threadId: source.id,
    point: { type: "turn", runId: sourceRun.id },
    input: "Continue fork",
    budgetBytes: 4096,
  });
  if (!fork.forkThreadId) throw new Error("Missing fork ID");
  const item = Object.values(daemon.store.snapshotThread(fork.forkThreadId).items).find(
    (candidate) => candidate.type === "message" && candidate.role === "assistant",
  );
  if (!item) throw new Error("Missing fork answer");
  await command({
    type: "thread.merge",
    threadId: fork.forkThreadId,
    summary: "Apply fork change",
    citations: [{ threadId: fork.forkThreadId, itemId: item.id }],
    patch:
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
  });
  expect(await readFile(join(home, "file.txt"), "utf8")).toBe("after\n");
  expect(Object.values(daemon.store.snapshotThread(source.id).items)).toContainEqual(
    expect.objectContaining({
      type: "message",
      mergedContext: expect.objectContaining({
        sourceThreadId: fork.forkThreadId,
        patchApplied: true,
      }),
    }),
  );
  expect(errors).toEqual([]);

  const root = source.rootAgentId;
  if (!root) throw new Error("Missing source root agent");
  const lease = daemon.mcp.openSession(
    {
      sessionId: "composition-browser",
      threadId: source.id,
      agentId: root,
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  try {
    const result = Result.parse(
      await (
        await invoke({ url: daemon.mcp.url, bearer: lease.bearer }, "ace_browser_close", {})
      ).json(),
    );
    expect(result.result.isError).not.toBe(true);
    expect(result.result.content).toEqual([{ text: '{"closed":true}' }]);
  } finally {
    lease.end();
  }
});
