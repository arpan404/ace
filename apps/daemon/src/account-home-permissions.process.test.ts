import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { AccountService, openRegistry, openRegistryIndex } from "@ace/accounts";
import { createModelDiscovery, ModelCatalog, openModelStorage } from "@ace/models";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AdapterRegistry, startDaemon } from "@ace/daemon";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command, type ThreadId } from "@ace/protocol";
import { prepareDaemonHome } from "@ace/service";
import { AccountManagement } from "./account-management.ts";
import { createManagedHome, prepareOpenCodeHome } from "./account-homes.ts";
import { commandContext } from "./commands.ts";
import { scriptFrames, start, end } from "./engine/test-support.ts";

const sessionCapabilities = {
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "none" as const,
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
};

// The real edge here is the filesystem: folders OpenCode runs in, their owner bits, and the
// paths that repair them before a discovery or a session. Discovery and the CLI's own failure
// use the adapter's boundary double, so the damage is measured the way OpenCode reports it.
const now = () => 1_800_000_000_000;
/** Run in place: the double imports the adapter's contract by relative path. */
const openCodeDouble = fileURLToPath(
  new URL("../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ownerMode = async (path: string) => (await lstat(path)).mode & 0o777;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-home-")));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const env = { HOME: join(root, "home"), PATH: process.env.PATH };
  const accounts = new AccountService({ registry, env, now, timeZone: "UTC" });
  const create = () =>
    new AccountManagement({
      registry,
      accounts,
      dataDir: root,
      env,
      platform: process.platform,
      now,
      id: () => `account-${randomUUID()}`,
      models: () => undefined,
      configuration: () => ({ enabled: false }),
    });
  let management = create();
  await management.initialize();
  cleanups.push(async () => {
    await management.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async add() {
      const reply = await management.handle("owner", {
        type: "accounts.add",
        requestId: "add",
        provider: "opencode",
        label: "Work",
      });
      if (reply.type !== "accounts.changed" || !reply.account)
        throw new Error("Missing added account");
      return reply.account;
    },
    /** A daemon restart on the same data folder, as the next launch does. */
    async restart() {
      await management.close();
      management = create();
      await management.initialize();
    },
  };
}

/** The same account, discovered and refreshed through a real catalog and the boundary double. */
async function discoveryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-catalog-")));
  const bin = join(root, "bin");
  await mkdir(bin);
  // The double starts with `#!/usr/bin/env node`; this machine's runtime answers to that name
  // from the fixture's own PATH entry, and OpenCode is this account's `opencode` command.
  await symlink(openCodeDouble, join(bin, "opencode"));
  await symlink(process.execPath, join(bin, "node"));
  const env = {
    HOME: join(root, "home"),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    ACE_TEST_FREE_MODELS: "1",
  };
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const accounts = new AccountService({ registry, env, now, timeZone: "UTC" });
  const storage = openModelStorage(join(root, "models.sqlite"));
  const models = new ModelCatalog({
    storage,
    now,
    deadline: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    discover: createModelDiscovery(),
  });
  const create = () =>
    new AccountManagement({
      registry,
      accounts,
      dataDir: root,
      env,
      platform: process.platform,
      now,
      id: () => `account-${randomUUID()}`,
      models: () => models,
    });
  let management = create();
  await management.initialize();
  cleanups.push(async () => {
    await management.close();
    await models.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    registry,
    models,
    async add() {
      const reply = await management.handle("owner", {
        type: "accounts.add",
        requestId: "add",
        provider: "opencode",
        label: "Work",
      });
      if (reply.type !== "accounts.changed" || !reply.account)
        throw new Error("Missing added account");
      return reply.account;
    },
    /** A daemon restart on the same data folder, as the next launch does. */
    async restart() {
      await management.close();
      management = create();
      await management.initialize();
    },
  };
}

test("an added OpenCode account whose data folder loses its owner's access while ace runs still lists its models", async () => {
  if (process.platform === "win32") return;
  const f = await discoveryFixture();
  const account = await f.add();
  const data = join(f.root, "account-homes", account.id, "data", "opencode");
  await f.restart();
  const listed = () => f.models.list({ instance: account.id }).models.map((model) => model.id);
  await expect
    .poll(listed, { timeout: 20_000 })
    .toContain("opencode-go/muse-spark-1.3-contributor");
  // OpenCode 2.4.1 strips a managed home's owner access while ace runs: the folder stays the
  // same inode, and every later command in it fails with EACCES.
  await chmod(data, 0o600);
  await f.models.refresh({ instance: account.id });
  expect(f.models.list({ instance: account.id }).instances[0]?.error).toBeUndefined();
  expect(listed()).toContain("opencode-go/muse-spark-1.3-contributor");
  expect(await ownerMode(data)).toBe(0o700);
});

test("validateHome repairs an added OpenCode account's data folder before a session run", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-session-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const instance = await createManagedHome(
    root,
    "account-validate",
    "opencode",
    "Work",
    process.platform,
  );
  // The daemon's own wiring (services/accounts.ts), reached through the registry's public API.
  const registry = await openRegistryIndex(
    join(root, "accounts.sqlite"),
    undefined,
    root,
    {},
    {
      prepareHome: async (candidate) => {
        if (candidate.provider === "opencode" && candidate.managed)
          await prepareOpenCodeHome(candidate.homeDir, process.platform);
      },
    },
  );
  cleanups.push(async () => registry.close());
  await registry.register(instance);
  const data = join(instance.homeDir, "data", "opencode");
  await chmod(data, 0o600);
  await registry.validateHome(registry.get(instance.id)?.instance ?? instance);
  expect(await ownerMode(data)).toBe(0o700);
});

test("an added OpenCode account's folders are private and usable by OpenCode", async () => {
  const f = await fixture();
  const account = await f.add();
  const home = join(f.root, "account-homes", account.id);
  for (const name of ["data", "config", "state"]) {
    for (const dir of [join(home, name), join(home, name, "opencode")]) {
      expect((await lstat(dir)).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(await ownerMode(dir)).toBe(0o700);
    }
  }
});

test("an added OpenCode account whose data folder lost its owner's access works again after a restart", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  const account = await f.add();
  const data = join(f.root, "account-homes", account.id, "data", "opencode");
  const database = join(data, "opencode.db");
  await writeFile(database, "kept");
  await chmod(data, 0o600);
  await f.restart();
  await expect.poll(() => ownerMode(data), { timeout: 5000 }).toBe(0o700);
  expect(await readFile(database, "utf8")).toBe("kept");
});

test("a symlinked OpenCode folder in an added account is refused, not followed", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-link-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "elsewhere");
  await mkdir(target, { mode: 0o600 });
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  await symlink(target, join(home, "data"));
  await expect(prepareOpenCodeHome(home, "linux")).rejects.toThrow("Unsafe OpenCode home");
  expect(await ownerMode(target)).toBe(0o600);
});

test("a symlinked OpenCode home is refused, not followed", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-home-link-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const real = join(root, "real");
  await mkdir(real, { mode: 0o700 });
  const home = join(root, "home");
  await symlink(real, home);
  // The home itself must be the canonical path: repairing through a link touches another folder.
  await expect(prepareOpenCodeHome(home, "linux")).rejects.toThrow("Unsafe OpenCode home");
  await expect(lstat(join(real, "data"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a symlink swapped in for a data folder is refused, not followed", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-swap-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(outside, { mode: 0o600 });
  for (const swap of ["nested", "ancestor"] as const) {
    const home = join(root, swap);
    await mkdir(home, { mode: 0o700 });
    if (swap === "nested") {
      await mkdir(join(home, "data"), { mode: 0o700 });
      await symlink(outside, join(home, "data", "opencode"));
    } else {
      await symlink(outside, join(home, "data"));
    }
    await expect(prepareOpenCodeHome(home, "linux")).rejects.toThrow("Unsafe OpenCode home");
    // The folder outside the home is never repaired through the link.
    expect(await ownerMode(outside)).toBe(0o600);
  }
});

test("two repairs of a home missing its folders both finish", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-parallel-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  // Started together, both may try to create each folder; the loser verifies the winner's.
  await Promise.all([
    prepareOpenCodeHome(home, process.platform),
    prepareOpenCodeHome(home, process.platform),
  ]);
  for (const name of ["data", "config", "state"])
    for (const dir of [join(home, name), join(home, name, "opencode")])
      expect(await ownerMode(dir)).toBe(0o700);
});

test("a session in an added OpenCode account whose data folder lost its owner's access opens", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-opencode-session-open-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "daemon");
  prepareDaemonHome(dataDir);
  const instance = await createManagedHome(
    dataDir,
    "account-session",
    "opencode",
    "Work",
    process.platform,
  );
  const saved = await openRegistry(join(dataDir, "accounts.sqlite"));
  await saved.register(instance);
  saved.close();
  // The damage a managed home is known to take while ace runs (#2784).
  const data = join(instance.homeDir, "data", "opencode");
  await chmod(data, 0o600);

  const frames = scriptFrames();
  const frame = frames.frame(start, end);
  const payload = new ProviderPayload(JSON.stringify(frame.data));
  const opened: { instance: string | undefined; dataHome: string | undefined }[] = [];
  const scripted = createScriptedAdapter({
    provider: "opencode",
    nativeSessionId: "native",
    capabilities: sessionCapabilities,
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [{ ...frame, payload, data: payload.data }] }],
  });
  const adapters = new AdapterRegistry();
  cleanups.push(() => adapters.close());
  adapters.register(
    {
      ...scripted,
      async openSession(context) {
        opened.push({ instance: context.instanceId, dataHome: context.env?.["XDG_DATA_HOME"] });
        return scripted.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: {
      dataDir,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    engine: { registry: adapters },
    accounts: { env: process.env },
  });
  cleanups.push(() => daemon.close());
  const workspaceId = daemon.store.createWorkspace(dataDir, "workspace");
  const threadId = randomUUID() as ThreadId;
  const create = Command.parse({
    id: randomUUID(),
    deviceId: "host",
    createdAt: 1,
    payload: {
      type: "thread.create",
      threadId,
      workspaceId,
      provider: "opencode",
      instanceId: instance.id,
      input: [{ type: "text", text: "synthetic" }],
    },
  });
  expect(daemon.engine?.handler.handle(create, commandContext(daemon.store)).ok).toBe(true);
  await vi.waitFor(() => expect(daemon.store.getThread(threadId)?.status.state).toBe("done"), {
    timeout: 10000,
  });
  // The session opened in the account's own data folder, after ace repaired its access.
  expect(await ownerMode(data)).toBe(0o700);
  expect(opened).toEqual([{ instance: instance.id, dataHome: join(instance.homeDir, "data") }]);
});
