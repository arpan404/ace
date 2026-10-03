import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { Engine, Store } from "./index.ts";
import { startDaemonMcp } from "./mcp.ts";
import { daemonClaudeAdapter } from "./services/claude.ts";
import { discoverAdapters } from "./engine/adapters.ts";

test("discovered Claude sessions connect service MCP leases and forward rate metadata to their owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-claude-registration-"));
  const executable = join(home, "claude");
  const script = fileURLToPath(new URL("./testing/claude-controls.ts", import.meta.url));
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
  const store = new Store(join(home, "events.sqlite"));
  const mcp = await startDaemonMcp(store);
  const cli = {
    installed: true,
    path: executable,
    version: "2.1.286",
    auth: "unknown" as const,
    loginHint: "local CLI",
  };
  const absent = { installed: false, auth: "unknown" as const, loginHint: "local CLI" };
  const observation = Promise.withResolvers<unknown>();
  const registry = await discoverAdapters(
    async () => ({ claude: cli, codex: absent, opencode: absent, cursor: absent }),
    (discovery) =>
      daemonClaudeAdapter(
        {
          store,
          services: { mcp },
          id: () => "lease",
          options: {
            claude: {
              env: { HOME: home },
              onRateLimit(thread, info) {
                observation.resolve({ thread, info });
              },
            },
          },
        },
        discovery,
      ),
  );
  const engine = new Engine(store, {
    registry,
    threadId: () => "registered",
    onError(error) {
      observation.reject(error);
    },
  });
  try {
    const workspaceId = store.createWorkspace(home, "Synthetic");
    const command = Command.parse({
      id: "create",
      deviceId: "host",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "claude",
        input: [{ type: "text", text: "synthetic" }],
      },
    });
    expect(
      store.recordCommand(command.id, command.deviceId, () => engine.handler.handle(command, store))
        .ok,
    ).toBe(true);
    await engine.flush();
    const thread = store.listThreads()[0];
    if (!thread) throw new Error("Missing created thread");
    expect(await observation.promise).toEqual({
      thread: thread.id,
      info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1900000000,
        utilization: 1.1,
        extension: "retained",
      },
    });
    const controls = mcp.providers.require(thread.id);
    const status = await controls.status();
    expect(status).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "ace", validAceConnection: true })]),
    );
    expect(JSON.stringify(status)).not.toMatch(/Bearer [a-f0-9]{64}/);
    await controls.reconnect("reject-lease").then(
      () => {
        throw new Error("Expected native reconnect failure");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("reconnect failed");
        expect(String(error)).not.toMatch(/Bearer [a-f0-9]{64}/);
      },
    );
    await controls.replace({ tools: { type: "http", url: "http://127.0.0.1:12345/mcp" } });
    expect(await controls.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ace" }),
        expect.objectContaining({ name: "tools" }),
      ]),
    );
    await controls.replace({});
    await engine.flush();
    expect(JSON.stringify(store.readEvents({ afterSeq: 0, limit: 256 }))).not.toMatch(
      /Bearer [a-f0-9]{64}/,
    );
    expect(await controls.status()).toEqual([expect.objectContaining({ name: "ace" })]);
    await engine.close();
    expect(() => mcp.providers.require(thread.id)).toThrow("not live");
  } finally {
    await engine.close();
    await registry.close();
    await mcp.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
