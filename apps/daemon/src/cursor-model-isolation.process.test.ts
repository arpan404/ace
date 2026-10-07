import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@ace/daemon";
import { createInstance, openRegistry } from "@ace/accounts";
import { spawnSupervised } from "@ace/provider-kit/process";
import { readConfig } from "./config.ts";
import { ModelCatalog, ModelInstance, openModelStorage, normalizeCursorSdk } from "@ace/models";

afterEach(() => vi.unstubAllEnvs());
test.each(["default", "configured", "selected", "configured-missing-sdk"] as const)(
  "Cursor model discovery uses the %s SDK home even when agent is on PATH",
  async (selection) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-model-home-")));
    const dataDir = join(root, "daemon");
    await mkdir(dataDir);
    const instance = {
      id: selection === "selected" ? "account" : "cursor-sdk-default",
      homeDir:
        selection === "default"
          ? join(dataDir, "instances", "cursor-sdk-default")
          : join(root, "private-sdk"),
    };
    const entry = join(root, "models.mjs");
    await writeFile(
      entry,
      `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method!=='models') process.exit(9);console.log(JSON.stringify({id:r.id,result:[{id:'private-model',displayName:process.env.HOME}]}));});`,
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
        handler: {
          handle(command) {
            return { commandId: command.id, ok: false, error: "unused" };
          },
        },
        engine: {
          cursor: {
            env: {},
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
        modelDiscovery: {
          spawn(options) {
            return spawnSupervised({ ...options, command: process.execPath, args: [entry] });
          },
        },
      });
      expect(
        daemon.models.list({ provider: "cursor" }).instances.map((row) => row.instance),
      ).toEqual([instance.id]);
      await daemon.models.refresh({ provider: "cursor" });
      expect(daemon.models.list({ provider: "cursor" }).models).toMatchObject([
        { id: "private-model", instance: instance.id, displayName: join(instance.homeDir, "user") },
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
