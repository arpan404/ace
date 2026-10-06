import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import type { Frame } from "@ace/engine-api";
import { Agent, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./index.ts";
import { startDaemonMcp } from "./mcp.ts";
import { bindMcpSession } from "./services/mcp-session.ts";

it("OpenCode v2 sessions in one account call their own scoped MCP tools and redact credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-opencode-mcp-"));
  const store = new Store(":memory:");
  const mcp = await startDaemonMcp(store);
  const binary = join(directory, "opencode");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.env.ACE_TEST_PROVIDER="opencode"; await import(${JSON.stringify(new URL("./testing/mcp-provider.ts", import.meta.url).href)});\n`,
  );
  await chmod(binary, 0o700);
  const adapter = createOpenCodeAdapter({ discovery: { overrides: { opencode: binary } } });
  onTestFinished(async () => {
    try {
      await adapter.close();
    } finally {
      await mcp.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  let id = 0;
  const open = async () => {
    const thread = createDevThread(store, store.createWorkspace(directory, "MCP"));
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
            native: { provider: "opencode" },
            fidelity: "full",
            cwd: directory,
            status: { state: "idle" },
            createdAt: 1,
          }),
        },
      ],
      1,
    );
    const proof = Promise.withResolvers<string>();
    const frames: Frame[] = [];
    const session = await bindMcpSession(
      adapter,
      {
        threadId: thread.id,
        instanceId: "shared-account",
        cwd: directory,
        env: { PATH: directory },
        signal: new AbortController().signal,
        onExit() {},
        onFrame(frame) {
          frames.push(frame);
          const data = JSON.stringify(frame.data);
          if (data.includes('"mcpProof":')) proof.resolve(data);
        },
      },
      { mcp, store, id: () => `session-${++id}`, capabilities: ["agents"] },
    );
    return { thread, session, frames, proof: await proof.promise };
  };
  const a = await open();
  const b = await open();
  expect(a.proof).toContain(a.thread.id);
  expect(a.proof).not.toContain(b.thread.id);
  expect(b.proof).toContain(b.thread.id);
  expect(b.proof).not.toContain(a.thread.id);
  expect(JSON.stringify([...a.frames, ...b.frames])).not.toMatch(/[a-f0-9]{64}/);
  expect(JSON.stringify([...a.frames, ...b.frames])).toContain("[redacted]");
  // This older provider omits command.list. A 404 must leave both live sessions usable.
  for (const { frames } of [a, b])
    expect(
      frames.filter((frame) => frame.channel === "commands.runtime").map((frame) => frame.data),
    ).toEqual([{ sessionUpdate: "available_commands_update", availableCommands: [] }]);
  await a.session.close("shutdown");
  // Closing A must not revoke B's credentials or stop B's native transport.
  await b.session.interrupt({ agent: "root", cascade: false });
  expect(b.frames.some((frame) => JSON.stringify(frame.data).includes('"interrupted":true'))).toBe(
    true,
  );
  await b.session.close("shutdown");
});

it("OpenCode refuses scoped MCP credentials on an externally owned server", async () => {
  const adapter = createOpenCodeAdapter({
    attach: { url: "http://127.0.0.1:1/", authorization: "Basic external", version: "2.0.22" },
  });
  onTestFinished(() => adapter.close());
  await expect(
    adapter.openSession({
      threadId: ThreadId.parse("external"),
      cwd: "/test",
      signal: new AbortController().signal,
      aceMcp: { url: "http://127.0.0.1:2/mcp", bearer: "a".repeat(64) },
      onFrame() {},
      onExit() {},
    }),
  ).rejects.toThrow("Scoped ace MCP requires an owned OpenCode server");
});
