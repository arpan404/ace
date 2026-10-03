import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { startDaemon, readConfig } from "./index.ts";

async function syntheticCli(home: string): Promise<string> {
  const executable = join(home, "claude");
  const script = fileURLToPath(new URL("./testing/claude-controls.ts", import.meta.url));
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
  return executable;
}

test.each(["default", "registered"])(
  "%s Claude sessions preserve account admission, MCP leases and rate observations",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "ace-claude-registration-"));
    const executable = await syntheticCli(home);
    const account = createInstance({
      id: "selected",
      provider: "claude",
      label: "Selected",
      homeDir: join(home, "claude-config"),
    });
    await mkdir(account.homeDir);
    if (mode === "registered") {
      const accounts = await openRegistry(join(home, "accounts.sqlite"));
      try {
        await accounts.register(account);
        accounts.ingest(account.id, {
          provider: "claude",
          observedAt: 1,
          timeZone: "UTC",
          payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
        });
      } finally {
        accounts.close();
      }
    }
    const cli = {
      installed: true,
      path: executable,
      version: "2.1.286",
      auth: "unknown" as const,
      loginHint: "local CLI",
    };
    const absent = { installed: false, auth: "unknown" as const, loginHint: "local CLI" };
    const observation = Promise.withResolvers<unknown>();
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      engine: {
        adapterDiscovery: async () => ({
          claude: cli,
          codex: absent,
          opencode: absent,
          cursor: absent,
        }),
        threadId: () => "registered",
        onError: (error) => observation.reject(error),
      },
      claude: {
        env: { HOME: home },
        onRateLimit(thread, info) {
          observation.resolve({ thread, info });
        },
      },
    });
    const { store, mcp, engine } = daemon;
    if (!engine) throw new Error("Missing engine service");
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
        store.recordCommand(command.id, command.deviceId, () =>
          engine.handler.handle(command, store),
        ).ok,
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
        expect.arrayContaining([
          expect.objectContaining({ name: "ace", validAceConnection: true }),
        ]),
      );
      expect(JSON.stringify(status)).not.toMatch(/Bearer [a-f0-9]{64}/);
      if (mode === "registered") {
        expect(status).toEqual([
          expect.objectContaining({ configDir: await realpath(account.homeDir) }),
        ]);
        expect(
          await daemon.accounts?.handle({
            type: "accounts.status",
            requestId: "quota",
            instanceId: account.id,
          }),
        ).toMatchObject({
          account: {
            id: account.id,
            quota: { windows: { five_hour: { usedPercent: 100, resetsAt: 1900000000000 } } },
          },
        });
      }
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
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("account-bound Claude sessions retain native MCP controls in their selected home", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-claude-account-controls-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  const instance = createInstance({
    id: "selected",
    provider: "claude",
    label: "Selected",
    homeDir: join(home, "config"),
  });
  await mkdir(instance.homeDir);
  await registry.register(instance);
  const accounts = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} });
  try {
    const { session } = await accounts.openSession(
      createClaudeAdapter({ executable: await syntheticCli(home), env: { HOME: home } }),
      {
        threadId: ThreadId.parse("controls"),
        cwd: home,
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      },
      { instanceId: instance.id, role: "worker", estimatedLoad: 1 },
    );
    try {
      const controls = session.mcp;
      if (!controls) throw new Error("Account binding lost native MCP controls");
      await controls.replace({ tools: { type: "http", url: "http://127.0.0.1:12345/mcp" } });
      expect(await controls.status()).toEqual([
        expect.objectContaining({ name: "tools", configDir: await realpath(instance.homeDir) }),
      ]);
      expect(session.instanceId).toBe(instance.id);
    } finally {
      await session.close("shutdown");
    }
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
