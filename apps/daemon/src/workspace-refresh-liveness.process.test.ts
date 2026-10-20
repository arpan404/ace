import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { Thread, ThreadId, type ThreadDetails, type ThreadStatus } from "@ace/protocol";
import { migrateEngine } from "./engine/migrations.ts";
import { Store } from "./store.ts";
import { VirtualSchedule } from "./virtual-schedule-test-support.ts";
import { WorkspaceRefresh } from "./workspace-refresh.ts";
import { deadlineOf, RefreshTimeout } from "./workspace-refresh-deadline.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const git = promisify(execFile);
const second = 1_000;
const minute = 60 * second;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function repository(root: string) {
  await mkdir(root, { recursive: true });
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
}

/**
 * Threads on real checkouts refreshed by the production loop on virtual time. Git status in a
 * checkout named in `hangs` never returns, as a stuck Git or forge read would.
 */
async function threads(
  names: string[],
  status: ThreadStatus,
  {
    hangs = [],
    viewed = true,
    details: initial,
  }: { hangs?: string[]; viewed?: boolean; details?: ThreadDetails } = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-refresh-liveness-")));
  const store = new Store(join(home, "events.sqlite"));
  store.atomic((db) => migrateEngine(db));
  const roots = new Map<string, string>();
  for (const name of names) {
    const root = join(home, name);
    await repository(root);
    roots.set(name, root);
    const thread = Thread.parse({
      id: name,
      workspaceId: store.createWorkspace(root, name),
      provider: "codex",
      title: name,
      status,
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    if (initial)
      store.appendEvents(thread.id, [
        { type: "thread.client.updated", changes: { details: initial } },
      ]);
    if (viewed) store.acquireThread(thread.id);
  }
  const stuck = new Set(hangs.map((name) => roots.get(name)));
  const time = new VirtualSchedule();
  const runtime = new WorkspaceRuntime(store, home, time.now, {
    git: {
      processRuntime: {
        spawn(binary, args, options) {
          const cwd = String(options.cwd ?? "");
          if (args.includes("status") && stuck.has(cwd))
            return spawn("sleep", ["30"], { ...options, stdio: "pipe" });
          return spawnGitProcess(binary, args, options);
        },
      },
    },
  });
  const failures: unknown[] = [];
  const refresh = new WorkspaceRefresh(
    store,
    runtime,
    time.now,
    time.schedule,
    (error) => failures.push(error),
    deadlineOf(300),
  );
  cleanups.push(async () => {
    await refresh.close();
    await runtime.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  await time.armedAtLeast(2);
  const details = (name: string) => store.getThread(ThreadId.parse(name))?.details;
  return { store, roots, time, failures, details };
}

test("a read that never returns does not stop the refresh; other threads keep updating", async () => {
  const { roots, time, failures, details } = await threads(
    ["stuck", "healthy"],
    { state: "done" },
    { hangs: ["stuck"] },
  );
  expect(failures).toEqual([expect.any(RefreshTimeout)]);
  expect(details("healthy")?.diff?.files).toBe(0);

  await writeFile(join(roots.get("healthy") ?? "", "edited.txt"), "new\n");
  await time.advance(minute);
  expect(details("healthy")?.diff?.files).toBe(1);
  await writeFile(join(roots.get("healthy") ?? "", "again.txt"), "new\n");
  await time.advance(minute);
  expect(details("healthy")?.diff?.files).toBe(2);
});

test("an agent's branch switch shows within seconds while it works, before any sweep", async () => {
  const { roots, time, details } = await threads(["agent"], { state: "working", agents: 1 });
  expect(details("agent")?.branch).toBe("main");
  await time.advance(5 * second);
  await git("git", ["-C", roots.get("agent") ?? "", "checkout", "-q", "-b", "ace/feature"]);
  await time.advance(5 * second);
  expect(details("agent")?.branch).toBe("ace/feature");
});

test("a thread whose read changed its details waits behind threads not yet read", async () => {
  // A pull request link change makes a thread due, and every details change carries the links.
  const names = Array.from({ length: 10 }, (_, index) => `thread-${index}`);
  const { time, details } = await threads(
    names,
    { state: "done" },
    { viewed: false, details: { linkedPrs: [] } },
  );
  await time.advance(minute);
  for (const name of names) expect(details(name)?.branch).toBe("main");
});

test("an unchanged checkout records no details change on later sweeps", async () => {
  const { store, time, details } = await threads(["quiet"], { state: "done" });
  expect(details("quiet")?.branch).toBe("main");
  let changes = 0;
  const stop = store.subscribe((events) => {
    changes += events.filter((event) => event.payload.type === "thread.client.updated").length;
  });
  await time.advance(3 * minute);
  stop();
  expect(changes).toBe(0);
});
