import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ModelCatalog, createModelDiscovery, openModelStorage } from "./index.ts";
import type { AcpProbeLaunch } from "./discover.ts";
import { Clock, fakeCli, workspace } from "./testing/support.ts";
import type { CatalogStorage, InstanceInput } from "./types.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const session = {
  sessionId: "probe",
  configOptions: [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "flash",
      options: [
        { value: "flash", name: "Flash" },
        { value: "pro", name: "Pro" },
      ],
    },
    {
      id: "mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default", description: "Ask before tools" },
        { value: "yolo", name: "YOLO", description: "Auto-approve all tools" },
      ],
    },
  ],
};

/** An ACP agent the catalog may probe, launched as the fake CLI from ace's own probe folder. */
async function agent(
  modelProbe: "automatic" | "on-request",
  options: {
    payload?: unknown;
    modes?: AcpProbeLaunch["modes"];
    /** The version the agent reports in its `initialize` reply. */
    reports?: string;
  } = {},
) {
  const work = await workspace();
  cleanups.push(work.close);
  const script = await fakeCli(work.path);
  const log = join(work.path, "methods.log");
  const folder = join(work.path, "probe-folder");
  const row: InstanceInput = {
    id: "acp-agent",
    provider: "acp",
    acpAgentId: "official:example",
    installationId: "example-install",
    instanceId: "example-default",
    loginRevision: "login-1",
    executable: process.execPath,
    cwd: folder,
    profileRevision: modelProbe === "automatic" ? "example-v1" : "generic-v1",
    installationVersion: "1.0.0",
    modelProbe,
  };
  let spawns = 0;
  const discover = createModelDiscovery({
    spawn(spawnOptions) {
      spawns++;
      return spawnSupervised(spawnOptions);
    },
    acpProbe: async () => ({
      // The probe's owner makes its folder when the probe starts.
      ...(await mkdir(folder, { recursive: true }).then(() => ({}))),
      command: process.execPath,
      args: [script],
      env: {
        FAKE_PROVIDER: "acp",
        FAKE_PAYLOAD: JSON.stringify(options.payload ?? session),
        FAKE_METHOD_LOG: log,
        ...(options.reports ? { FAKE_AGENT_VERSION: options.reports } : {}),
      },
      cwd: folder,
      modes: options.modes ?? "reported",
    }),
  });
  const clock = new Clock();
  const open = (storage: CatalogStorage = openModelStorage(join(work.path, "models.sqlite"))) => {
    const catalog = new ModelCatalog({
      storage,
      discover,
      instances: [row],
      now: () => clock.now,
      deadline: clock.deadline,
      random: () => 0.5,
    });
    cleanups.push(() => catalog.close());
    return catalog;
  };
  const methods = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line): [string, string | undefined] => JSON.parse(line));
  return { row, open, folder, methods, clock, spawns: () => spawns, path: work.path };
}

test("a reviewed ACP agent first starts when the person loads it, once, in ace's folder, never prompting", async () => {
  const { open, folder, methods, spawns } = await agent("automatic");
  const catalog = open();
  // Opening the catalog, its background pass and reads start nothing: the agent would start
  // the MCP servers its own configuration names, so its first start is the person's.
  catalog.revalidate();
  catalog.list();
  await catalog.loadMissing({ instance: "acp-agent" });
  expect(spawns()).toBe(0);
  expect(catalog.list().instances[0]?.modelProbe).toBe("on-request");
  await catalog.load("acp-agent");
  expect(catalog.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  catalog.list();
  await catalog.loadMissing({ instance: "acp-agent" });
  expect(spawns()).toBe(1);
  const calls = await methods();
  expect(calls.map(([method]) => method)).not.toContain("session/prompt");
  expect(calls.filter(([method]) => method === "session/new")).toEqual([["session/new", folder]]);
  const status = catalog.list().instances[0];
  expect(status?.modelProbe).toBe("automatic");
  // The modes the probe's session reported are the row's before any thread opens.
  expect(status?.permissionModes?.map((mode) => mode.id)).toEqual(["default", "yolo"]);
});

test("refresh and sign-in start no agent; the next read loads a reviewed agent's reset row once", async () => {
  const { open, spawns, clock } = await agent("automatic");
  const catalog = open();
  await catalog.load("acp-agent");
  expect(spawns()).toBe(1);
  clock.now += 60_000;
  await catalog.refresh();
  await catalog.refresh({ instance: "acp-agent" });
  expect(spawns()).toBe(1);
  // The reset row keeps its list until the read that loads it again.
  expect(catalog.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  await catalog.loadMissing();
  catalog.list();
  await vi.waitFor(() => expect(spawns()).toBe(2));
  clock.now += 60_000;
  // A new login drops the previous login's list at once, and starts nothing itself.
  await catalog.loginChanged("acp-agent", "login-2");
  expect(spawns()).toBe(2);
  expect(catalog.list().models).toEqual([]);
  await catalog.loadMissing();
  expect(spawns()).toBe(3);
  expect(catalog.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
});

test("an unprofiled ACP agent starts only when the person loads that agent's models", async () => {
  const { open, spawns, methods } = await agent("on-request");
  const catalog = open();
  catalog.revalidate();
  catalog.list();
  catalog.resolve({ provider: "acp", role: "worker" });
  await catalog.loadMissing();
  await catalog.refresh();
  await catalog.refresh({ provider: "acp" });
  // A refresh naming the row is any operate device's, an agent's included: it starts nothing.
  await catalog.refresh({ instance: "acp-agent" });
  await catalog.loginChanged("acp-agent", "login-2");
  catalog.list();
  await catalog.loadMissing();
  expect(spawns()).toBe(0);
  expect(catalog.list().instances[0]).toMatchObject({ modelProbe: "on-request" });
  await catalog.load("acp-agent");
  expect(spawns()).toBe(1);
  expect(catalog.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  expect((await methods()).map(([method]) => method)).not.toContain("session/prompt");
});

test("loading an agent again and again starts it at most once a minute", async () => {
  const { open, spawns, clock } = await agent("on-request");
  const catalog = open();
  await catalog.load("acp-agent");
  for (let attempt = 0; attempt < 5; attempt++) {
    clock.now += 10_000;
    await catalog.load("acp-agent");
  }
  expect(spawns()).toBe(1);
  clock.now += 10_000;
  await catalog.load("acp-agent");
  expect(spawns()).toBe(2);
});

test("a reviewed agent that reports a version its profile doesn't cover opens no probe session", async () => {
  const { open, spawns, methods } = await agent("automatic", { reports: "2.0.0" });
  const catalog = open();
  await catalog.load("acp-agent");
  expect(spawns()).toBe(1);
  expect((await methods()).map(([method]) => method)).toEqual(["initialize"]);
  expect(catalog.list().models).toEqual([]);
  const same = await agent("automatic", { reports: "1.0.0" });
  const loaded = same.open();
  await loaded.load("acp-agent");
  expect(loaded.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
});

test("a restart serves the cached ACP row without a probe, whichever folder registers it", async () => {
  const { row, open, spawns } = await agent("automatic");
  const first = open();
  await first.load("acp-agent");
  await first.close();
  expect(spawns()).toBe(1);
  const second = open();
  second.registerInstance({ ...row, cwd: "/some/other/project" });
  second.revalidate();
  expect(second.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  await second.loadMissing();
  expect(spawns()).toBe(1);
});

test("a row written while the folder was part of ACP identity is kept, not deleted", async () => {
  const { open, spawns, path } = await agent("automatic");
  // An older build hashed the session's folder into the row's identity.
  const storage = openModelStorage(join(path, "models.sqlite"));
  const older: CatalogStorage = {
    load: () => storage.load(),
    replace: (entry) =>
      storage.replace({ ...entry, identityRevision: "hashed-with-a-project-folder" }),
    remove: (instance) => storage.remove(instance),
    close: () => storage.close(),
  };
  const first = open(older);
  await first.load("acp-agent");
  await first.close();
  const second = open();
  expect(second.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  await second.loadMissing();
  expect(spawns()).toBe(1);
});

test("modes a probe sees in an untrusted folder are left for a session to report", async () => {
  const { open } = await agent("automatic", { modes: "needs-session" });
  const catalog = open();
  await catalog.load("acp-agent");
  const status = catalog.list().instances[0];
  expect(catalog.list().models.map((model) => model.id)).toEqual(["flash", "pro"]);
  expect(status?.permissionModes).toEqual([]);
});

test("an ACP agent that lists no models loads an empty row and is not probed again", async () => {
  const { open, spawns } = await agent("automatic", {
    payload: { sessionId: "probe", configOptions: [] },
  });
  const catalog = open();
  await catalog.load("acp-agent");
  catalog.list();
  await catalog.loadMissing();
  expect(spawns()).toBe(1);
  expect(catalog.list().instances[0]).not.toHaveProperty("errorDetail");
});
