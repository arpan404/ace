import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelCatalog, ModelInstance, normalizeCodex, openModelStorage } from "@ace/models";
import { createLogger } from "@ace/diagnostics";
import { fixture } from "../socket-test-support.ts";
import { readConfig } from "../config.ts";
import { Resources } from "../services/resources.ts";
import { startProviderInstalls } from "../services/provider-install.ts";
import type { ServiceContext } from "../services/types.ts";
import { installFixture } from "./testing.ts";

test("daemon installation success replaces model installation metadata before reporting final readiness", async () => {
  const f = await installFixture({ managers: ["npm"] });
  const root = await fixture();
  const resources = new Resources();
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(f.home, "models.sqlite")),
    now: () => 1000,
    deadline: () => () => {},
    instances: [
      {
        id: "codex-cli-default",
        provider: "codex",
        executable: join(f.bin, "codex"),
        cwd: f.home,
        loginRevision: "0",
      },
    ],
    discover: async (instance) =>
      normalizeCodex(
        {
          data: [
            {
              id: "fixture",
              model: instance.installationVersion === "2.0.0" ? "after-update" : "before-update",
              displayName: "Fixture",
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        },
        ModelInstance.parse(instance),
      ),
  });
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await f.existing("codex");
    await catalog.refresh();
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: f.home, ACE_PORT: "0" }, f.home),
      options: { providerStatus: { env: f.env } },
      signal: new AbortController().signal,
      services: { models: catalog, providerStatuses: f.statuses },
      resources,
      store: root.store,
      now: () => 1000,
      id: () => "fixture",
      log,
      onListen: [],
    };
    startProviderInstalls(context);
    const installs = context.services.providerInstalls;
    if (!installs) throw new Error("Installer unavailable");
    server = await fixture({ providerInstalls: installs, models: catalog });
    const client = await server.connect();
    client.receiveCatalogPushes = true;
    await client.next();
    client.send({
      type: "models.list",
      requestId: "before",
      options: { provider: "codex", offset: 0, limit: 100 },
    });
    expect(await client.next()).toMatchObject({
      type: "models.result",
      result: { models: [expect.objectContaining({ nativeModelId: "before-update" })] },
    });
    client.send({
      type: "provider.install.run",
      requestId: "update",
      provider: "codex",
      action: "update",
      method: "npm",
    });
    const modelPush = Promise.withResolvers<void>();
    const stop = catalog.listen?.(() => modelPush.resolve());
    try {
      for (;;) {
        const message = await client.next();
        if (message.type === "provider.install.progress" && message.progress.state === "failed")
          throw new Error(message.progress.message);
        if (message.type === "provider.install.progress" && message.progress.state === "succeeded")
          break;
      }
      await modelPush.promise;
      await catalog.refresh();
      client.send({
        type: "models.list",
        requestId: "after",
        options: { provider: "codex", offset: 0, limit: 100 },
      });
      for (;;) {
        const message = await client.next();
        if (message.type !== "models.result") continue;
        expect(message).toMatchObject({
          result: {
            models: [expect.objectContaining({ nativeModelId: "after-update" })],
          },
        });
        break;
      }
      expect(await readFile(join(f.home, "installed-version"), "utf8")).toBe("2.0.0");
      expect(f.statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
        version: "2.0.0",
        installed: true,
      });
    } finally {
      stop?.();
    }
  } finally {
    await server?.close();
    await resources.close();
    await catalog.close();
    await log.close();
    await root.close();
    await f.close();
  }
});
