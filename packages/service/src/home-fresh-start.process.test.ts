import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  BACKUP_README,
  HOME_FORMAT_FILE,
  claimHome,
  describeBackup,
  prepareDaemonHome,
  resolveDaemonHome,
  type FreshStartPorts,
} from "./home.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A temporary user home: `~/.ace` and its backups live here, never in the real one. */
async function userHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-fresh-start-"));
  roots.push(root);
  return root;
}

const at = new Date("2026-10-15T12:00:00.000Z");
const ports = (version?: number): FreshStartPorts => ({
  now: () => at,
  claim: (root) => claimHome(root),
  ...(version === undefined ? {} : { version }),
});

/** The pre-format `~/.ace` found on real machines: launcher, daemon data, user data, worktrees. */
async function legacyHome(home: string): Promise<string> {
  const root = join(home, ".ace");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "ace"), '#!/bin/sh\nexec old-ace "$@"\n', { mode: 0o755 });
  await mkdir(join(root, "daemon"));
  await writeFile(join(root, "daemon", "state.sqlite"), "legacy state");
  await mkdir(join(root, "userdata"));
  await writeFile(join(root, "userdata", "notes.json"), "{}");
  await mkdir(join(root, "worktrees", "repo"), { recursive: true });
  return root;
}

/** Every entry under `root` with its size and modification time, to show nothing changed. */
async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return Promise.all(
    entries.toSorted().map(async (entry) => {
      const info = await lstat(join(root, entry));
      return `${entry} ${info.size} ${info.mtimeMs}`;
    }),
  );
}

async function marker(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, HOME_FORMAT_FILE), "utf8"));
}

test("a legacy unversioned ~/.ace is renamed to ~/.ace-v0 and a fresh v1 home is created", async () => {
  const home = await userHome();
  const legacy = await legacyHome(home);
  const before = await snapshot(legacy);
  const inode = (await stat(legacy)).ino;

  const prepared = prepareDaemonHome(resolveDaemonHome(home), ports());

  const backup = join(home, ".ace-v0");
  expect(prepared).toEqual({
    state: "fresh",
    root: legacy,
    backup,
    previousFormat: "ace-v0",
  });
  // One rename: the same directory, every entry unchanged, nothing copied.
  expect((await stat(backup)).ino).toBe(inode);
  expect(await snapshot(backup)).toEqual(before);
  expect(await readdir(legacy)).toEqual([HOME_FORMAT_FILE]);
  expect(await marker(legacy)).toEqual({ format: "ace-v1", createdAt: at.toISOString() });
  expect((await stat(legacy)).mode & 0o777).toBe(0o700);
  expect((await readdir(home)).toSorted()).toEqual([".ace", ".ace-v0"]);

  // The follow-up explains the backup inside it and measures it; it never deletes anything.
  const { bytes } = await describeBackup({ backup, home: legacy, previousFormat: "ace-v0", at });
  expect(bytes).toBeGreaterThanOrEqual("legacy state".length);
  const readme = await readFile(join(backup, BACKUP_README), "utf8");
  expect(readme).toContain(legacy);
  expect(readme).toContain("never reads it again");
  expect(await readFile(join(backup, "daemon", "state.sqlite"), "utf8")).toBe("legacy state");
});

test("an existing ~/.ace-v0 backup is never overwritten", async () => {
  const home = await userHome();
  for (const name of [".ace-v0", ".ace-v0.1"]) {
    await mkdir(join(home, name));
    await writeFile(join(home, name, "kept"), name);
  }
  const earlier = await Promise.all(
    [".ace-v0", ".ace-v0.1"].map((name) => snapshot(join(home, name))),
  );
  await legacyHome(home);

  const prepared = prepareDaemonHome(resolveDaemonHome(home), ports());

  expect(prepared).toMatchObject({ state: "fresh", backup: join(home, ".ace-v0.2") });
  expect(await readFile(join(home, ".ace-v0.2", "daemon", "state.sqlite"), "utf8")).toBe(
    "legacy state",
  );
  expect(
    await Promise.all([".ace-v0", ".ace-v0.1"].map((name) => snapshot(join(home, name)))),
  ).toEqual(earlier);
});

test("a current-format home is reused untouched", async () => {
  const home = await userHome();
  const root = resolveDaemonHome(home);
  expect(prepareDaemonHome(root, ports())).toEqual({ state: "created", root });
  await writeFile(join(root, "events.sqlite"), "threads");
  await mkdir(join(root, "worktrees"));
  const before = await snapshot(root);

  expect(prepareDaemonHome(root, ports())).toEqual({ state: "reused", root });

  expect(await snapshot(root)).toEqual(before);
  expect(await readdir(home)).toEqual([".ace"]);
});

test("the format bump from v1 to v2 backs up to ~/.ace-v1", async () => {
  const home = await userHome();
  const root = resolveDaemonHome(home);
  prepareDaemonHome(root, ports());
  await writeFile(join(root, "events.sqlite"), "v1 threads");

  const prepared = prepareDaemonHome(root, ports(2));

  expect(prepared).toEqual({
    state: "fresh",
    root,
    backup: join(home, ".ace-v1"),
    previousFormat: "ace-v1",
  });
  expect(await readFile(join(home, ".ace-v1", "events.sqlite"), "utf8")).toBe("v1 threads");
  expect(await marker(root)).toEqual({ format: "ace-v2", createdAt: at.toISOString() });
  // And a v1 build then refuses the v2 home rather than setting it aside.
  expect(() => prepareDaemonHome(root, ports(1))).toThrow(
    /data format ace-v2, build supports ace-v1/,
  );
  expect((await readdir(home)).toSorted()).toEqual([".ace", ".ace-v1"]);
});

test("an explicit ACE_HOME gets the same versioning, with its backup beside it", async () => {
  const home = await userHome();
  const explicit = join(home, "work", "ace-data");
  await mkdir(explicit, { recursive: true });
  await writeFile(join(explicit, "settings.json"), "{}");

  const prepared = prepareDaemonHome(resolveDaemonHome(home, explicit), ports());

  expect(prepared).toMatchObject({ state: "fresh", backup: join(home, "work", "ace-data-v0") });
  expect(await readdir(explicit)).toEqual([HOME_FORMAT_FILE]);
  // An empty ACE_HOME (a new temp directory, say) has nothing to back up and is adopted.
  const empty = join(home, "empty-home");
  await mkdir(empty);
  expect(prepareDaemonHome(empty, ports())).toEqual({ state: "created", root: empty });
  expect(await readdir(join(home))).not.toContain("empty-home-v0");
});

test("a home that is a link is set aside as the link, and what it points at stays put", async () => {
  const home = await userHome();
  const elsewhere = join(home, "volume", "old-ace");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "ace.db"), "legacy");
  await symlink(elsewhere, join(home, ".ace"));

  const prepared = prepareDaemonHome(resolveDaemonHome(home), ports());

  expect(prepared).toMatchObject({ state: "fresh", backup: join(home, ".ace-v0") });
  expect(await readlink(join(home, ".ace-v0"))).toBe(elsewhere);
  expect(await readdir(elsewhere)).toEqual(["ace.db"]);
  expect((await lstat(join(home, ".ace"))).isDirectory()).toBe(true);
});

test("a crashed old daemon's leftover lock does not block the fresh start", async () => {
  const home = await userHome();
  const legacy = await legacyHome(home);
  // A pid no process has: the daemon that wrote this lock is gone.
  await writeFile(join(legacy, "daemon-lock"), JSON.stringify({ pid: 2 ** 22 + 17, id: "old" }));

  expect(prepareDaemonHome(resolveDaemonHome(home), ports())).toMatchObject({ state: "fresh" });
  expect(await readFile(join(home, ".ace-v0", "daemon-lock"), "utf8")).toContain("old");
});
