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
import { afterEach, expect, test } from "vitest";
import { AccountService, openRegistry, openRegistryIndex } from "@ace/accounts";
import { createModelDiscovery, ModelCatalog, openModelStorage } from "@ace/models";
import { AccountManagement } from "./account-management.ts";
import { createManagedHome, prepareOpenCodeHome } from "./account-homes.ts";

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
  await expect.poll(listed, { timeout: 20_000 }).toContain("opencode-go/muse-spark-1.3-contributor");
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
  const registry = await openRegistryIndex(join(root, "accounts.sqlite"), undefined, root, {}, {
    prepareHome: async (candidate) => {
      if (candidate.provider === "opencode" && candidate.managed)
        await prepareOpenCodeHome(candidate.homeDir, process.platform);
    },
  });
  cleanups.push(() => registry.close());
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
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-link-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "elsewhere");
  await mkdir(target, { mode: 0o600 });
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  await symlink(target, join(home, "data"));
  await expect(prepareOpenCodeHome(home, "linux")).rejects.toThrow("Unsafe OpenCode home");
  expect(await ownerMode(target)).toBe(0o600);
});
