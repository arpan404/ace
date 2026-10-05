import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { z } from "zod";
import { ScreenManager, screenToolkit } from "@ace/screen";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";

it("cancelled MCP screen input never reaches the helper after an earlier action releases the queue", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-screen-cancel-"));
  const gate = join(home, "gate");
  await writeFile(gate, "held");
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./testing/agent-screen-helper.ts", import.meta.url).pathname],
    env: { ACE_SCREEN_GATE: gate },
    platform: "win32",
    endpoint: `unix:${join(home, "pipe")}`,
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  const entered = Promise.withResolvers<void>();
  const watcher = watch(home, (_event, filename) => {
    if (filename === "gate.entered") entered.resolve();
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(screen).register(registry);
  const lease = new CredentialRegistry(() => "a".repeat(64)).issue(
    McpScope.parse({
      sessionId: "cancel",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  try {
    await screen.enable(true);
    await screen.approve("dev.ace.journey", true);
    const state = await screen.start({ kind: "window", windowId: 1, bundleId: "dev.ace.journey" });
    screen.delegateAgent(state.sessionId, lease.principal.scope);
    const first = registry.call(
      "screen_type",
      { text: "gate" },
      lease.principal,
      new AbortController().signal,
    );
    await entered.promise;
    const cancelled = new AbortController();
    const second = registry.call(
      "screen_type",
      { text: "forbidden" },
      lease.principal,
      cancelled.signal,
    );
    cancelled.abort();
    expect(await second).toMatchObject({ isError: true });
    await writeFile(gate, "released");
    expect(await first).not.toHaveProperty("isError", true);
    // A subsequent queued input is a public barrier after the cancelled dispatch.
    await registry.call(
      "screen_type",
      { text: "!" },
      lease.principal,
      new AbortController().signal,
    );
    const tree = await screen.uiTree(state.sessionId, {});
    const value = z.object({ root: z.object({ value: z.string() }) }).parse(tree).root.value;
    expect(value).toBe("gate!");
  } finally {
    await writeFile(gate, "released");
    watcher.close();
    lease.end();
    await screen.close();
    await rm(home, { recursive: true, force: true });
  }
});
