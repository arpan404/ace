import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { Thread, type ThreadStatus } from "@ace/protocol";
import { migrateEngine } from "./engine/migrations.ts";
import { Store } from "./store.ts";
import { VirtualSchedule } from "./virtual-schedule-test-support.ts";
import { WorkspaceRefresh } from "./workspace-refresh.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const git = promisify(execFile);
const minute = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A thread on a real checkout, refreshed by the production sweep on virtual time. */
async function refreshing(status: ThreadStatus, options: { viewed?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-workspace-refresh-")));
  const root = join(home, "repo");
  await mkdir(root);
  await git("git", ["init", "-q", "--initial-branch=main", root]);
  await writeFile(join(root, "file.txt"), "one\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", [
    "-C",
    root,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e.invalid",
    "commit",
    "-qm",
    "Initial",
  ]);
  const store = new Store(join(home, "events.sqlite"));
  store.atomic((db) => migrateEngine(db));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Fixture",
    status,
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  if (options.viewed) store.acquireThread(thread.id);
  const time = new VirtualSchedule();
  let statusReads = 0;
  const runtime = new WorkspaceRuntime(store, home, time.now, {
    git: {
      processRuntime: {
        spawn(binary, args, spawnOptions) {
          if (args.includes("status")) statusReads++;
          return spawnGitProcess(binary, args, spawnOptions);
        },
      },
    },
  });
  const failures: unknown[] = [];
  const refresh = new WorkspaceRefresh(store, runtime, time.now, time.schedule, (error) =>
    failures.push(error),
  );
  cleanups.push(async () => {
    await refresh.close();
    await runtime.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  // The startup sweep and the head watch have both settled once each has re-armed.
  await time.armedAtLeast(2);
  expect(failures).toEqual([]);
  return {
    root,
    store,
    time,
    statusReads: () => statusReads,
    changedFiles: () => store.getThread(thread.id)?.details?.diff?.files,
    agentEdited: () =>
      store.appendEvents(thread.id, [{ type: "thread.updated", title: "Edited" }], time.at),
  };
}

test("a quiet thread nobody is viewing is not re-read every minute", async () => {
  const thread = await refreshing({ state: "new" });
  const before = thread.statusReads();
  await thread.time.advance(9 * minute);
  expect(thread.statusReads()).toBe(before);
});

test("a thread a client is viewing shows an edit made outside ace within a minute", async () => {
  const thread = await refreshing({ state: "done" }, { viewed: true });
  expect(thread.changedFiles()).toBe(0);
  await writeFile(join(thread.root, "edited-in-an-editor.txt"), "new\n");
  await thread.time.advance(minute);
  expect(thread.changedFiles()).toBe(1);
});

test("an agent's edit in a thread nobody is viewing shows by the next sweep", async () => {
  const thread = await refreshing({ state: "done" });
  await thread.time.advance(2 * minute);
  expect(thread.changedFiles()).toBe(0);
  await writeFile(join(thread.root, "file.txt"), "one\ntwo\n");
  thread.agentEdited();
  await thread.time.advance(minute);
  expect(thread.changedFiles()).toBe(1);
});
