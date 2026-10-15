import { mkdtemp, mkdir, readdir, rm, realpath, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, afterEach } from "vitest";
import { startDaemon, readConfig } from "@ace/daemon";
import { createInstance, openRegistry, runAccountsCommand } from "@ace/accounts";
import { daemonCursorAuth } from "@ace/accounts";
import { prepareDaemonHome } from "@ace/service";

afterEach(() => vi.unstubAllEnvs());

async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-home-defaults-")));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", root);
  return root;
}
const handler = {
  handle(command: import("@ace/protocol").Command) {
    return { commandId: command.id, ok: false, error: "unused" };
  },
};

test("accounts CLI and Cursor CLI auth use the daemon's default home, ~/.ace, and nothing else", async () => {
  const root = await home();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const env = { HOME: root };
    const output: string[] = [];
    await runAccountsCommand(["accounts", "list"], { env, write: (value) => output.push(value) });
    expect(output).toEqual(["[]\n"]);
    await access(join(root, ".ace", "accounts.sqlite"));
    daemon = await startDaemon({
      config: readConfig({ ...env, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
      handler,
      modelInstances: [],
      history: { instances: [] },
    });
    await writeFile(join(root, ".ace", "daemon-endpoint"), daemon.url.replace("ws:", "http:"));
    const auth = await daemonCursorAuth(env);
    try {
      expect(
        await auth.request(
          { type: "cursor.auth.status", instanceId: "cursor-sdk-default" },
          new AbortController().signal,
        ),
      ).toMatchObject({
        type: "cursor.auth.error",
        code: "unavailable",
      });
    } finally {
      await auth.close();
    }
    expect(await readdir(root)).toEqual([".ace"]);
  } finally {
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a genuinely different Cursor SDK home still refuses catalog discovery", async () => {
  const root = await home();
  const dataDir = join(root, "ace-data");
  prepareDaemonHome(dataDir);
  const userHome = join(root, ".cursor");
  await mkdir(userHome);
  const registry = await openRegistry(join(dataDir, "accounts.sqlite"), dataDir);
  await registry.register(
    createInstance({
      id: "cursor-sdk-default",
      provider: "cursor",
      label: "User SDK",
      homeDir: userHome,
    }),
  );
  registry.close();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({
      config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
      handler,
      history: { instances: [] },
      modelInstances: [
        {
          id: "cursor-sdk-default",
          provider: "cursor",
          backend: "cursor-sdk",
          homeDir: join(dataDir, "instances", "cursor-sdk-default"),
          cwd: root,
          loginRevision: "test",
        },
      ],
      modelDiscovery: {
        spawn() {
          throw new Error("No fake SDK host should be admitted for a mismatched account");
        },
      },
    });
    expect(await daemon.models.refresh()).toMatchObject([
      { stale: true, errorDetail: { code: "discovery_failed" } },
    ]);
    expect(daemon.models.list().models).toEqual([]);
    const persisted = await openRegistry(join(dataDir, "accounts.sqlite"), dataDir);
    try {
      expect(persisted.get("cursor-sdk-default")?.instance.homeDir).toBe(userHome);
    } finally {
      persisted.close();
    }
  } finally {
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
});
