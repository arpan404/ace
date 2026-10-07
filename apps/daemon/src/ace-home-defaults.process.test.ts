import { mkdtemp, mkdir, readdir, rm, realpath, writeFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, afterEach } from "vitest";
import { startDaemon, readConfig } from "@ace/daemon";
import { createInstance, openRegistry, runAccountsCommand } from "@ace/accounts";
import { daemonCursorAuth } from "@ace/accounts";
import { spawnSupervised } from "@ace/provider-kit/process";

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

test("accounts CLI and Cursor CLI auth use the daemon's default home without creating ~/.ace", async () => {
  const root = await home();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const env = { HOME: root };
    const output: string[] = [];
    await runAccountsCommand(["accounts", "list"], { env, write: (value) => output.push(value) });
    expect(output).toEqual(["[]\n"]);
    await access(join(root, ".ace-next", "accounts.sqlite"));
    daemon = await startDaemon({
      config: readConfig({ ...env, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
      handler,
      modelInstances: [],
      history: { instances: [] },
    });
    await writeFile(join(root, ".ace-next", "daemon-endpoint"), daemon.url.replace("ws:", "http:"));
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
    expect(await readdir(root)).toEqual([".ace-next"]);
  } finally {
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([".ace", ".ace-next-old", "nested"])(
  "daemon startup moves the %s SDK home before discovery and preserves user CLI homes",
  async (layout) => {
    const root = await home();
    const dataDir = join(root, ".ace-next");
    const id = "cursor-sdk-default";
    const oldRoot = join(root, layout === "nested" ? ".ace" : layout);
    const oldHome = join(oldRoot, "instances", ...(layout === "nested" ? ["cursor"] : []), id);
    await mkdir(oldHome, { recursive: true });
    if (layout === ".ace-next-old") await writeFile(join(oldRoot, "host-id"), "old-daemon");
    await mkdir(join(oldHome, "user", ".cursor", "sdk"), { recursive: true });
    // Opaque synthetic state. Test and fake SDK inspect existence/inodes only.
    const authFile = join(oldHome, "user", ".cursor", "sdk", "auth.json");
    await writeFile(authFile, "synthetic-auth-state");
    const previousAuth = await stat(authFile);
    const previousHome = await stat(oldHome);
    const userHomes = [".cursor", ".codex", ".claude"];
    for (const name of userHomes) await mkdir(join(root, name));
    const userStats = await Promise.all(userHomes.map((name) => stat(join(root, name))));
    const registry = await openRegistry(join(dataDir, "accounts.sqlite"), dataDir);
    await registry.register(
      createInstance({ id, provider: "cursor", label: "Cursor SDK", homeDir: oldHome }),
    );
    registry.close();
    const entry = join(root, "fake-sdk.mjs");
    await writeFile(
      entry,
      `import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);
if (!existsSync(join(process.env.HOME,'.cursor/sdk/auth.json'))) process.exit(9);
console.log(JSON.stringify({id:r.id,result:[{id:'migrated-model',displayName:process.env.HOME}]}));
});`,
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
        handler,
        history: { instances: [] },
        engine: {
          cursor: {
            env: {},
            discovery: {
              platform: "linux",
              arch: "x64",
              nodeVersion: "24.0.0",
              resolve: (name) =>
                name === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json",
              read: async (path) =>
                path === "/sdk/package.json"
                  ? '{"name":"@cursor/sdk","version":"1.0.35"}'
                  : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
              executable: async () => {},
            },
          },
        },
        modelDiscovery: {
          spawn: (options) =>
            spawnSupervised({ ...options, command: process.execPath, args: [entry] }),
        },
      });
      expect(await daemon.models.refresh({ provider: "cursor" })).toMatchObject([{ stale: false }]);
      const canonical = join(dataDir, "instances", id);
      expect(daemon.models.list({ provider: "cursor" }).models).toMatchObject([
        { id: "migrated-model", displayName: join(canonical, "user") },
      ]);
      expect((await stat(canonical)).ino).toBe(previousHome.ino);
      expect((await stat(join(canonical, "user", ".cursor", "sdk", "auth.json"))).ino).toBe(
        previousAuth.ino,
      );
      await expect(access(oldHome)).rejects.toMatchObject({ code: "ENOENT" });
      const persisted = await openRegistry(join(dataDir, "accounts.sqlite"), dataDir);
      try {
        expect(persisted.get(id)?.instance).toMatchObject({
          homeDir: canonical,
          env: { CURSOR_DATA_DIR: canonical },
        });
      } finally {
        persisted.close();
      }
      for (const [index, name] of userHomes.entries())
        expect(await stat(join(root, name))).toMatchObject({
          ino: userStats[index]?.ino,
          mtimeMs: userStats[index]?.mtimeMs,
        });
    } finally {
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a genuinely different Cursor SDK home still refuses catalog discovery", async () => {
  const root = await home();
  const dataDir = join(root, ".ace-next");
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
