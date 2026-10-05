import { afterEach, expect, test } from "vitest";
import { copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createModelDiscovery, ModelCatalog, openModelStorage } from "./index.ts";
import { Clock, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

for (const empty of [false, true])
  test.each(["auto-review", "ask", "read-only", "full-access"] as const)(
    `OpenCode catalog selection opens without sending input (%s, fallback=${empty})`,
    async (permissionMode) => {
      const work = await workspace();
      cleanup.push(work.close);
      const executable = join(work.path, "opencode");
      await copyFile(
        new URL("../../adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
        executable,
      );
      await chmod(executable, 0o700);
      const env = { HOME: work.path, ACE_TEST_EMPTY_MODELS: String(empty) };
      const rows = await createModelDiscovery()(
        { ...instance("opencode"), executable, cwd: work.path, env },
        new AbortController().signal,
      );
      const selected = rows.find((row) => row.id === "opencode-go/muse-spark-1.3-contributor");
      if (!selected) throw new Error("Missing discovered model");
      const requests: { path: string; body: unknown }[] = [];
      const adapter = createOpenCodeAdapter({
        discovery: { overrides: { opencode: executable }, env },
        runtime: {
          fetch: async (input, init) => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            if (init?.method === "POST")
              requests.push({
                path: url.pathname,
                body: typeof init.body === "string" ? JSON.parse(init.body) : null,
              });
            return fetch(input, init);
          },
        },
      });
      cleanup.push(() => adapter.close());
      // New thread carries CatalogModel.nativeModelId unchanged to SessionContext.model.
      const session = await adapter.openSession({
        threadId: ThreadId.parse("thread_catalog_open"),
        cwd: work.path,
        model: selected.nativeModelId,
        permissionMode,
        signal: new AbortController().signal,
        onFrame: () => {},
        onExit: () => {},
      });
      expect(session.nativeSessionId).toBeTruthy();
      expect(requests).toEqual([
        {
          path: "/api/session",
          body: {
            title: "ace",
            location: { directory: work.path },
            model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
            permissions: [
              {
                action: "*",
                resource: "*",
                effect: permissionMode === "full-access" ? "allow" : "ask",
              },
            ],
          },
        },
      ]);
    },
  );

test("a persisted OpenCode choice from before the fix opens after restart without catalog refresh", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const executable = join(work.path, "opencode");
  await copyFile(
    new URL("../../adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
    executable,
  );
  await chmod(executable, 0o700);
  const config = { ...instance("opencode"), executable, cwd: work.path, env: { HOME: work.path } };
  const rows = await createModelDiscovery()(config, new AbortController().signal);
  const row = rows[0];
  if (!row) throw new Error("Missing discovered model");
  const path = join(work.path, "models.sqlite");
  // Seed the actual legacy bytes: storage.replace already runs the repairing schema.
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE model_catalog (instance TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  legacy.prepare("INSERT INTO model_catalog(instance, payload) VALUES (?, ?)").run(
    config.id,
    JSON.stringify({
      instance: config.id,
      provider: "opencode",
      revision: config.loginRevision,
      refreshedAt: 0,
      models: [{ ...row, nativeModelId: "muse-spark-1.3-contributor" }],
    }),
  );
  legacy.close();
  const clock = new Clock();
  const catalog = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [config],
    now: () => 0,
    deadline: clock.deadline,
    discover: async () => {
      throw new Error("Offline discovery must not be needed");
    },
  });
  cleanup.push(() => catalog.close());
  const selected = catalog.list().models[0];
  if (!selected) throw new Error("Missing cached choice");
  const creates: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    discovery: { overrides: { opencode: executable }, env: config.env },
    runtime: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (
          url.pathname === "/api/session" &&
          init?.method === "POST" &&
          typeof init.body === "string"
        )
          creates.push(JSON.parse(init.body));
        return fetch(input, init);
      },
    },
  });
  cleanup.push(() => adapter.close());
  const session = await adapter.openSession({
    threadId: ThreadId.parse("thread_cached_open"),
    cwd: work.path,
    model: selected.nativeModelId,
    signal: new AbortController().signal,
    onFrame: () => {},
    onExit: () => {},
  });
  expect(session.nativeSessionId).toBeTruthy();
  expect(creates).toEqual([
    expect.objectContaining({
      model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
    }),
  ]);
});
