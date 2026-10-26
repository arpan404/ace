import { mkdirSync, writeFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitService } from "@ace/git";
import { PinnedDirectory } from "@ace/workspace";
import { HostId, WorkspaceId, type TransferMethod } from "@ace/protocol";
import { Store } from "../store.ts";
import { identityAt } from "./files.ts";
import { IncomingRows, type IncomingRecord } from "./incoming-rows.ts";
import { IncomingTransfers } from "./incoming.ts";
import { headRef, landTransfer, type LandingDeps, type TargetProjects } from "./landing.ts";
import { changesRef } from "./prepare.ts";
import type { TransferArchive, TransferGit } from "./ports.ts";
import { git } from "./transfer-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function scratch(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A dependency these tests never reach; calling it fails the test. */
function unused<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_target, name) => () => {
      throw new Error(`Not expected: ${String(name)}`);
    },
  });
}

/** The target's projects: new ones are made in `root`, held open as the real owner does. */
function projectsIn(root: string, unregistered: string[] = []): TargetProjects {
  return {
    list: () => [],
    parent: async (requested) => {
      const handle = PinnedDirectory.open(requested ?? root);
      return { path: requested ?? root, handle, close: () => handle.close() };
    },
    clone: unused<TargetProjects>().clone,
    register: async ({ path }) => WorkspaceId.parse(`workspace-${path.length}`),
    unregister: async (workspaceId) => {
      unregistered.push(workspaceId);
    },
  };
}

function record(method: TransferMethod, commit: IncomingRecord["commit"]): IncomingRecord {
  return {
    transferId: "transfer-1",
    deviceId: "device-1",
    state: "importing",
    method,
    begin: {
      op: "begin",
      transferId: "transfer-1",
      origin: { hostId: HostId.parse("host-macbook"), hostName: "MacBook" },
      method,
      name: "app",
    },
    commit,
    updatedAt: 1,
  };
}

function landing(overrides: Partial<LandingDeps> & Pick<LandingDeps, "projects">): LandingDeps {
  return {
    git: unused<TransferGit>(),
    archive: unused<TransferArchive>(),
    threads: unused(),
    held: new Set(),
    made: () => undefined,
    attempt: "1",
    cutoff: () => undefined,
    created: () => undefined,
    ...overrides,
  };
}

it("a folder name another import takes before this one makes it stays theirs when this one fails", async () => {
  const root = await scratch("ace-transfer-owner-");
  const archive = join(root, "copy.tar");
  await writeFile(archive, "not reached");
  let theirs: string | undefined;
  const landed = landTransfer(
    landing({
      projects: projectsIn(root),
      // Right after the name is reserved, someone else makes a folder there.
      made: (change) => {
        if (!change.createdPath || theirs) return;
        theirs = change.createdPath;
        mkdirSync(theirs);
        writeFileSync(join(theirs, "theirs.txt"), "their work\n");
      },
    }),
    record("archive", {
      op: "commit",
      transferId: "transfer-1",
      file: { bytes: 11, sha256: "0".repeat(64) },
    }),
    archive,
    new AbortController().signal,
  );

  await expect(landed).rejects.toMatchObject({ code: "EEXIST" });
  expect(theirs).toBe(join(root, "app"));
  expect(await readFile(join(root, "app", "theirs.txt"), "utf8")).toBe("their work\n");
});

/** The target's transfers after a restart, over a temp store, with rows a crash left. */
async function restarted(root: string, rows: (rows: IncomingRows) => void) {
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  rows(new IncomingRows(store));
  const logs: string[] = [];
  const incoming = new IncomingTransfers({
    store,
    directory: join(root, "incoming"),
    git: unused<TransferGit>(),
    archive: unused<TransferArchive>(),
    projects: projectsIn(root),
    threads: unused(),
    now: () => 2,
    log: (message) => logs.push(message),
  });
  await incoming.recover();
  await incoming.close();
  const left = store
    .statement("SELECT path FROM transfer_incoming_left ORDER BY path")
    .all()
    .map((row) => String(row["path"]));
  return { logs, left };
}

/** A cancelled transfer whose rollback a crash interrupted, naming a folder it made. */
function interrupted(rows: IncomingRows, transferId: string, path: string, createdId?: string) {
  const row = { ...record("archive", undefined), transferId, state: "cancelled" as const };
  rows.insert({ ...row, begin: { ...row.begin, transferId } }, 1);
  rows.update(transferId, { state: "cancelled", createdPath: path, createdId }, 1);
}

it("after a restart, rollback removes the folder a transfer made but not one that replaced it", async () => {
  const root = await scratch("ace-transfer-restart-");
  const projects = join(root, "projects");
  await mkdir(projects);
  // The transfer made `app`; afterwards it moved away and someone else's folder took the name.
  const replaced = join(projects, "app");
  await mkdir(replaced);
  const madeId = identityAt(replaced);
  await rename(replaced, join(projects, "app-moved"));
  await mkdir(replaced);
  await writeFile(join(replaced, "theirs.txt"), "their work\n");
  // A second transfer's folder is still the one it made.
  const own = join(projects, "web");
  await mkdir(own);
  await writeFile(join(own, "partial.txt"), "half landed\n");
  const ownId = identityAt(own);

  const { left } = await restarted(root, (rows) => {
    interrupted(rows, "transfer-replaced", replaced, madeId);
    interrupted(rows, "transfer-own", own, ownId);
  });

  expect(await readFile(join(replaced, "theirs.txt"), "utf8")).toBe("their work\n");
  await expect(stat(own)).rejects.toMatchObject({ code: "ENOENT" });
  expect(left).toEqual([]);
});

it("after a restart, a reserved folder whose identity was never recorded is left in place and recorded", async () => {
  const root = await scratch("ace-transfer-unproven-");
  const projects = join(root, "projects");
  await mkdir(projects);
  // A crash came after the folder was made and before the transfer recorded it as its own.
  const unproven = join(projects, "app");
  await mkdir(unproven);
  await writeFile(join(unproven, "README.md"), "whose?\n");

  const { left, logs } = await restarted(root, (rows) =>
    interrupted(rows, "transfer-unproven", unproven),
  );

  expect(await readFile(join(unproven, "README.md"), "utf8")).toBe("whose?\n");
  expect(left).toEqual([unproven]);
  expect(logs).toContain("Transfer folder left in place");
});

it("checkout and changes land in the folder the transfer made, even when its path is swapped after the clone", async () => {
  const root = await scratch("ace-transfer-swap-");
  const service = new GitService();
  cleanup.push(() => service.close());
  const transfer = service.transfer;
  // The source: a detached HEAD ahead of main, with an uncommitted file.
  const source = join(root, "source");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await writeFile(join(source, "README.md"), "hello\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "first");
  await git(source, "switch", "--detach");
  await writeFile(join(source, "next.txt"), "next\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "next");
  const head = await git(source, "rev-parse", "HEAD");
  await writeFile(join(source, "wip.txt"), "half done\n");
  const changes = await transfer.captureChanges(source, { ref: changesRef("transfer-1") });
  if (!changes) throw new Error("No changes captured");
  await transfer.pinRef(source, headRef("transfer-1"), head);
  const bundle = join(root, "app.bundle");
  await transfer.createBundle(source, {
    file: bundle,
    refs: ["refs/heads/main", headRef("transfer-1"), changesRef("transfer-1")],
  });

  const projects = join(root, "projects");
  await mkdir(projects);
  const path = join(projects, "app");
  const moved = join(projects, "app-moved");
  // Once the clone is there, the folder is moved away and an identical copy takes its path.
  const swapping: TransferGit = new Proxy(transfer, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (name !== "checkoutBranch" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await cp(path, join(root, "copy"), { recursive: true, verbatimSymlinks: true });
        await rename(path, moved);
        await rename(join(root, "copy"), path);
        return Reflect.apply(value, target, args);
      };
    },
  });

  const landed = await landTransfer(
    landing({ git: swapping, projects: projectsIn(projects) }),
    record("bundle", {
      op: "commit",
      transferId: "transfer-1",
      file: { bytes: 1, sha256: "0".repeat(64) },
      head,
      changes: { ref: changesRef("transfer-1"), commit: changes.commit },
    }),
    bundle,
    new AbortController().signal,
  );

  const branch = `detached-${head.slice(0, 12)}`;
  expect(landed.branch).toBe(branch);
  // Every write after the clone went to the folder the transfer made, wherever it is now.
  expect(await git(moved, "branch", "--show-current")).toBe(branch);
  expect(await git(moved, "status", "--porcelain")).toBe("?? wip.txt");
  // The copy now at its old path is as the clone left it.
  expect(await git(path, "branch", "--show-current")).toBe("main");
  expect(await git(path, "status", "--porcelain")).toBe("");
});
