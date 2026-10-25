import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as pause } from "node:timers/promises";
import { ModelCatalog, normalizeCodex, openModelStorage, type ModelInstance } from "@ace/models";
import { ProviderKind } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { applyInstallations, installationGate } from "./installation-gate.ts";
import { ProviderStatuses } from "./provider-status.ts";
import { fakeCli } from "./provider-status-test-support.ts";
import { registerDefaultModelInstances } from "./models.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const payload = {
  data: [
    {
      id: "catalog-coder",
      model: "coder",
      displayName: "CODER",
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
      contextWindow: 200000,
    },
  ],
  nextCursor: null,
};

/** A home with a `codex` executable on PATH, and a catalog whose discoveries are recorded. */
async function bootCatalog() {
  const root = await mkdtemp(join(tmpdir(), "ace-installation-gate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "codex"), 0o755);
  const discoveries: (string | undefined)[] = [];
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(root, "models.sqlite")),
    instances: [],
    now: () => 1,
    deadline: () => () => {},
    random: () => 0.5,
    discover: async (config: ModelInstance) => {
      discoveries.push(config.installationVersion);
      return normalizeCodex(payload, config);
    },
  });
  cleanup.push(() => catalog.close());
  const register = (admit: () => Promise<void>) =>
    registerDefaultModelInstances(
      catalog,
      root,
      { PATH: bin },
      new AbortController().signal,
      new Set(ProviderKind.options.filter((kind) => kind !== "codex")),
      [],
      admit,
    );
  return { catalog, discoveries, register };
}

/** Until discovered models are listed, then long enough for any repeat discovery to start. */
async function settled(catalog: ModelCatalog) {
  for (let i = 0; i < 1000 && catalog.list().models.length === 0; i++) await pause(10);
  await pause(50);
}

test("a CLI's catalog is discovered once at startup, at the version the first provider check reports", async () => {
  const { catalog, discoveries, register } = await bootCatalog();
  const firstCheck = Promise.withResolvers<void>();
  await register(installationGate(firstCheck.promise, 10_000, () => () => {}));
  catalog.revalidate();
  await tick();
  // Startup asked for discovery before the provider check knew which Codex is installed.
  catalog.installationChanged("codex", "0.200.0");
  firstCheck.resolve();
  await settled(catalog);
  expect(discoveries).toEqual(["0.200.0"]);
  expect(catalog.list().models.map((model) => model.id)).toEqual(["coder"]);
});

test("a provider check that never finishes holds catalog discovery only until the wait ends", async () => {
  const { catalog, discoveries, register } = await bootCatalog();
  const waitEnds = Promise.withResolvers<void>();
  await register(
    installationGate(new Promise<void>(() => {}), 10_000, (run) => {
      void waitEnds.promise.then(run);
      return () => {};
    }),
  );
  catalog.revalidate();
  for (let i = 0; i < 20; i++) await tick();
  expect(discoveries).toEqual([]);
  waitEnds.resolve();
  await settled(catalog);
  expect(discoveries).toEqual([undefined]);
  expect(catalog.list().models.map((model) => model.id)).toEqual(["coder"]);
});

test("a provider check that finishes before the CLIs register still gives discovery their version", async () => {
  const { catalog, discoveries, register } = await bootCatalog();
  // The check reports Codex while the default instances are still being found on PATH.
  catalog.installationChanged("codex", "0.200.0");
  await register(installationGate(Promise.resolve(), 10_000, () => () => {}));
  catalog.revalidate();
  await settled(catalog);
  expect(discoveries).toEqual(["0.200.0"]);
  expect(catalog.list().models.map((model) => model.id)).toEqual(["coder"]);
});

test("versions from a provider check that finished before the catalog existed reach its first discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-installation-early-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await fakeCli(root, "codex", "codex-cli 0.200.0", "Logged in using ChatGPT", "login status");
  const statuses = new ProviderStatuses(
    { env: { HOME: root, PATH: root } },
    { now: () => 1, schedule: () => () => {} },
  );
  cleanup.push(() => statuses.close());
  // Startup order: the provider check completes while the model service is still opening.
  await statuses.firstCheck();
  const { catalog, discoveries, register } = await bootCatalog();
  applyInstallations(catalog, statuses.installations());
  await register(installationGate(statuses.firstCheck(), 10_000, () => () => {}));
  catalog.revalidate();
  await settled(catalog);
  expect(discoveries).toEqual(["0.200.0"]);
});
