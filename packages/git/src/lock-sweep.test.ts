import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GitProcess } from "./git-processes.ts";
import { healRepositories, type LeaseProbe } from "./lease-admission.ts";
import { scheduleProbe } from "./lease-owner.ts";

const now = new Date("2026-11-14T12:00:00Z");
const old = new Date(now.getTime() - 10 * 60_000);
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "ace-lock-sweep-")));
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** A repository laid out as Git leaves it on disk, with `worktrees` linked checkouts. */
async function repository(name: string, worktrees = 0) {
  const root = join(home, name);
  const common = join(root, ".git");
  await mkdir(join(common, "refs", "heads", "feature"), { recursive: true });
  const linked: string[] = [];
  for (let index = 0; index < worktrees; index++) {
    const path = join(home, `${name}-wt${index}`);
    const metadata = join(common, "worktrees", `wt${index}`);
    await mkdir(metadata, { recursive: true });
    await mkdir(path);
    await writeFile(join(path, ".git"), `gitdir: ${metadata}\n`);
    await writeFile(join(metadata, "gitdir"), `${join(path, ".git")}\n`);
    await writeFile(join(metadata, "commondir"), "../..\n");
    linked.push(path);
  }
  return { root, common, linked };
}

async function lock(file: string, written = old) {
  await writeFile(file, "");
  await utimes(file, written, written);
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

function probe(processes: readonly GitProcess[] = []) {
  let scans = 0;
  const value: LeaseProbe = {
    schedule: scheduleProbe,
    evidence: {
      processes: async () => {
        scans++;
        return processes;
      },
      groupAlive: () => false,
      now: () => now,
    },
  };
  return { value, scans: () => scans };
}

const failures: unknown[] = [];
const failed = (_path: string, error: unknown) => failures.push(error);
afterEach(() => {
  expect(failures.splice(0)).toEqual([]);
});

test("a sweep with no lock files lists no processes", async () => {
  const a = await repository("a", 2);
  const b = await repository("b");
  const p = probe();
  await healRepositories([a.root, ...a.linked, b.root], failed, p.value);
  expect(p.scans()).toBe(0);
});

test("a fresh lock is left alone without listing processes", async () => {
  const a = await repository("a");
  await lock(join(a.common, "index.lock"), new Date(now.getTime() - 1_000));
  const p = probe();
  expect(await healRepositories([a.root], failed, p.value)).toEqual([]);
  expect(p.scans()).toBe(0);
  expect(await exists(join(a.common, "index.lock"))).toBe(true);
});

test("stale locks across repositories and their worktrees are healed with one process listing", async () => {
  const a = await repository("a", 2);
  const b = await repository("b");
  const index = join(a.common, "index.lock");
  const ref = join(a.common, "refs", "heads", "feature", "x.lock");
  const linkedIndex = join(a.common, "worktrees", "wt1", "index.lock");
  const other = join(b.common, "packed-refs.lock");
  for (const file of [index, ref, linkedIndex, other]) await lock(file);
  const p = probe();
  const removed = await healRepositories([a.root, ...a.linked, b.root], failed, p.value);
  expect(removed.toSorted()).toEqual([index, ref, linkedIndex, other].toSorted());
  expect(p.scans()).toBe(1);
  for (const file of removed) expect(await exists(file)).toBe(false);
});

test("a stale-looking lock a live Git process may hold is kept", async () => {
  const a = await repository("a", 1);
  const [linked = ""] = a.linked;
  const own = join(a.common, "worktrees", "wt0", "index.lock");
  const main = join(a.common, "index.lock");
  await lock(own);
  await lock(main);
  const holder: GitProcess = {
    pid: 4242,
    cwd: linked,
    checkout: linked,
    startedAt: old.getTime() - 1_000,
  };
  const p = probe([holder]);
  expect(await healRepositories([a.root], failed, p.value)).toEqual([main]);
  expect(await exists(own)).toBe(true);
});

test("without a process listing nothing is removed", async () => {
  const a = await repository("a");
  await lock(join(a.common, "index.lock"));
  const value: LeaseProbe = {
    schedule: scheduleProbe,
    evidence: { processes: async () => undefined, groupAlive: () => false, now: () => now },
  };
  expect(await healRepositories([a.root], failed, value)).toEqual([]);
  expect(await exists(join(a.common, "index.lock"))).toBe(true);
});
