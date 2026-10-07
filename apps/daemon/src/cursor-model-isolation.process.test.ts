import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { startDaemon, AdapterRegistry } from "@ace/daemon";
import { createInstance, openRegistry } from "@ace/accounts";
import { spawnSupervised } from "@ace/provider-kit/process";
import { readConfig } from "./config.ts";
import { ModelCatalog, ModelInstance, openModelStorage, normalizeCursorSdk } from "@ace/models";

afterEach(() => vi.unstubAllEnvs());
test.each([
  "default",
  "default-alias",
  "default-legacy-model-instance",
  "configured",
  "selected",
  "configured-missing-sdk",
] as const)(
  "Cursor model discovery uses the %s SDK home even when agent is on PATH",
  async (selection) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-model-home-")));
    const alias = join(root, "alias");
    if (selection === "default-alias") await symlink(root, alias);
    const dataDir = join(selection === "default-alias" ? alias : root, "daemon");
    await mkdir(dataDir);
    const instance = {
      id: selection === "selected" ? "account" : "cursor-sdk-default",
      homeDir: selection.startsWith("default")
        ? join(dataDir, "instances", "cursor-sdk-default")
        : join(root, "private-sdk"),
    };
    const entry = join(root, "models.mjs");
    await writeFile(
      entry,
      `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({id:r.id,result:r.method==='models'?[{id:'private-model',displayName:process.env.HOME}]:r.method==='status'?{status:'logged-out',source:'none'}:{disposed:true}}));});`,
    );
    await writeFile(join(root, "agent"), `#!${process.execPath}\nprocess.exit(99);`, {
      mode: 0o700,
    });
    vi.stubEnv("HOME", root);
    vi.stubEnv("PATH", root);
    if (selection === "selected") {
      const registry = await openRegistry(join(dataDir, "accounts.sqlite"));
      try {
        await registry.register(
          createInstance({ ...instance, provider: "cursor", label: "Private SDK" }),
        );
        registry.selectCursorSdk(instance.id);
      } finally {
        registry.close();
      }
    }
    const adapters = new AdapterRegistry();
    adapters.register(
      {
        provider: "cursor",
        backend: "cursor-sdk",
        capabilities: () => cursorCapabilities,
        createTranslator: (init) => new CursorTranslator(init),
        async openSession() {
          throw new Error("No sessions in discovery");
        },
      },
      { installed: true, auth: "unknown", loginHint: "fake" },
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        config: {
          ...readConfig({ ACE_HOME: dataDir }, root),
          host: "127.0.0.1",
          port: 0,
          remotePort: 0,
          listen: "local",
          logLevel: "silent",
        },
        toolkits: [],
        history: { instances: [] },
        ...(selection === "default-alias"
          ? {}
          : {
              handler: {
                handle(command: import("@ace/protocol").Command) {
                  return { commandId: command.id, ok: false, error: "unused" };
                },
              },
            }),
        engine: {
          ...(selection === "default-alias" ? { registry: adapters } : {}),
          cursor: {
            entry,
            env: {},
            discovery: {
              platform: "linux",
              arch: "x64",
              nodeVersion: "24.0.0",
              resolve: (id) => (id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json"),
              read: async (path) =>
                path === "/sdk/package.json"
                  ? '{"name":"@cursor/sdk","version":"1.0.35"}'
                  : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
              executable: async () => {},
            },
            ...(selection.startsWith("configured") ? { instance } : {}),
            ...(selection === "configured-missing-sdk"
              ? {
                  discovery: {
                    resolve() {
                      throw Object.assign(new Error("No SDK"), { code: "MODULE_NOT_FOUND" });
                    },
                  },
                }
              : {}),
          },
        },
        ...(selection === "default-legacy-model-instance"
          ? {
              modelInstances: [
                {
                  id: "cursor-cli-default",
                  provider: "cursor" as const,
                  executable: join(root, "agent"),
                  cwd: root,
                  loginRevision: "old-cli",
                },
              ],
            }
          : {}),
        modelDiscovery: {
          spawn(options) {
            return spawnSupervised({ ...options, command: process.execPath, args: [entry] });
          },
        },
      });
      expect(
        daemon.models.list({ provider: "cursor" }).instances.map((row) => row.instance),
      ).toEqual([instance.id]);
      if (selection === "default-alias") {
        const accounts = await daemon.accounts?.handle({
          type: "accounts.list",
          requestId: "test",
        });
        expect(accounts).toMatchObject({
          accounts: expect.arrayContaining([
            expect.objectContaining({ id: "cursor-sdk-default", implicit: false }),
          ]),
        });
      }
      await daemon.models.refresh({ provider: "cursor" });
      expect(daemon.models.list({ provider: "cursor" }).models).toMatchObject([
        {
          id: "private-model",
          instance: instance.id,
          displayName: join(
            root,
            selection.startsWith("default") ? "daemon/instances/cursor-sdk-default" : "private-sdk",
            "user",
          ),
        },
      ]);
    } finally {
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Cursor refresh ignores CLI versions and waits for the current SDK revision after discovery is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-cursor-version-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const instance = ModelInstance.parse({
    id: "private-account",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: root,
    cwd: root,
    loginRevision: "same-account",
    installationVersion: "1.0.35",
  });
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(root, "models.sqlite")),
    instances: [instance],
    now: () => 1,
    deadline: () => () => {},
    discover: async (config) => {
      if (config.installationVersion === "1.0.36") {
        started.resolve();
        await release.promise;
      }
      return normalizeCursorSdk(
        [
          {
            id:
              config.installationVersion === "1.0.35"
                ? "private-model"
                : config.installationVersion === "1.0.36"
                  ? "obsolete-model"
                  : "private-current",
            displayName: "Private model",
          },
        ],
        config,
      );
    },
  });
  try {
    await catalog.refresh();
    catalog.installationChanged("cursor", "2026.10.06", "cli");
    await catalog.refresh();
    expect(catalog.list().models.map((model) => model.id)).toEqual(["private-model"]);
    catalog.installationChanged("cursor", "1.0.36", "cursor-sdk");
    const refresh = catalog.refresh();
    await started.promise;
    catalog.installationChanged("cursor", "1.0.37", "cursor-sdk");
    release.resolve();
    expect(await refresh).toMatchObject([{ stale: false, refreshing: false }]);
    expect(catalog.list().models.map((model) => model.id)).toEqual(["private-current"]);
  } finally {
    release.resolve();
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["home", "provider"] as const)(
  "Cursor refuses a catalog whose registered %s differs",
  async (mismatch) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-mismatch-")));
    vi.stubEnv("HOME", root);
    vi.stubEnv("PATH", root);
    const registry = await openRegistry(join(root, "accounts.sqlite"));
    await registry.register(
      createInstance({
        id: "account",
        provider: mismatch === "provider" ? "codex" : "cursor",
        label: "Account",
        homeDir: join(root, "registered"),
      }),
    );
    registry.close();
    const entry = join(root, "models.mjs");
    await writeFile(
      entry,
      `import {createInterface} from "node:readline"; createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);console.log(JSON.stringify({id:r.id,result:[{id:"wrong-home-model",displayName:"Wrong home"}]}));});`,
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
        toolkits: [],
        history: { instances: [] },
        handler: {
          handle(command) {
            return { commandId: command.id, ok: false, error: "unused" };
          },
        },
        modelInstances: [
          {
            id: "account",
            provider: "cursor",
            backend: "cursor-sdk",
            homeDir: join(root, mismatch === "home" ? "other" : "registered"),
            cwd: root,
            loginRevision: "test",
          },
        ],
        modelDiscovery: {
          spawn(options) {
            return spawnSupervised({ ...options, command: process.execPath, args: [entry] });
          },
        },
      });
      expect(await daemon.models.refresh()).toMatchObject([
        { errorDetail: { code: "discovery_failed" } },
      ]);
      expect(daemon.models.list().models).toEqual([]);
    } finally {
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
