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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { AccountService, openRegistry } from "@ace/accounts";
import { AccountManagement } from "./account-management.ts";
import { prepareOpenCodeHome } from "./account-homes.ts";

// The real edge here is the filesystem: folders OpenCode runs in, their owner bits, and the
// startup path that repairs them. No CLI runs: the fixture disables provider probes.
const now = () => 1_800_000_000_000;
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
