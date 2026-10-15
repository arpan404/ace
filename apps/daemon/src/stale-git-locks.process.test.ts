import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetiredLease } from "@ace/git";
import { Command, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { git } from "./test-git.ts";

/** A local port nothing listens on: the endpoint of a daemon that has stopped. */
async function stoppedDaemonPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The durable intent a stopped daemon wrote before mutating `root`, and never retired. */
async function leftLease(repo: string, root: string, roots: string[] = [root]) {
  const journal = join(repo, ".git", "ace-mutation-leases");
  await mkdir(journal, { recursive: true });
  const id = randomUUID();
  const owner = { port: await stoppedDaemonPort(), token: randomUUID() };
  await writeFile(join(journal, id), JSON.stringify({ version: 1, id, root, owner, roots }));
  return join(journal, id);
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A real Git process working in `cwd` until stopped, like a person's own long-running `git`. */
async function holdGit(cwd: string) {
  const child = spawn("git", ["-c", "alias.hold=!sleep 300", "hold"], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  const pid = child.pid;
  if (!pid) throw new Error("Holder Git did not start");
  const exited = once(child, "exit");
  let stopped = false;
  return {
    pid,
    async stop() {
      if (!stopped) process.kill(-pid, "SIGKILL");
      stopped = true;
      await exited;
    },
  };
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-stale-locks-")));
  const repo = join(home, "repo");
  await mkdir(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "commit", "--allow-empty", "-m", "Initial");
  const store = new Store(join(home, "events.sqlite"));
  const workspaceId = store.createWorkspace(repo, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "opencode",
    title: "Fixture",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const retired: RetiredLease[] = [];
  const runtime = new WorkspaceRuntime(store, home, () => 1000, {
    git: { onLeaseRetired: (event) => retired.push(event) },
  });
  return {
    home,
    repo,
    thread,
    retired,
    runtime,
    async close() {
      await runtime.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("a previous instance's orphaned lease is retired at startup", async () => {
  const f = await fixture();
  try {
    // As a daemon killed mid-operation leaves it: rooted at the project, with nested worktrees.
    const nested = [
      join(f.repo, ".claude", "worktrees", "a"),
      join(f.repo, ".claude", "worktrees", "b"),
    ];
    for (const [index, path] of nested.entries())
      git(f.repo, "worktree", "add", "-b", `w${index}`, path);
    const stale = await leftLease(f.repo, f.repo, [f.repo, ...nested]);
    const failures: string[] = [];
    await f.runtime.sweepStaleLeases((path) => failures.push(path));
    expect(failures).toEqual([]);
    expect(await exists(stale)).toBe(false);
    expect(f.retired).toMatchObject([
      { repository: f.repo, reason: "owner_gone_processes_gone", lease: { root: f.repo } },
    ]);
    expect(await f.runtime.prepare(f.thread.id)).toBe(f.repo);
  } finally {
    await f.close();
  }
});

test("a lease held by a live git process is waited on, not retired, and the send completes when it ends", async () => {
  const f = await fixture();
  const holder = await holdGit(f.repo);
  try {
    const lease = await leftLease(f.repo, f.repo);
    let prepared = false;
    const preparing = f.runtime.prepare(f.thread.id).then((root) => {
      prepared = true;
      return root;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(prepared).toBe(false);
    expect(await exists(lease)).toBe(true);
    await holder.stop();
    expect(await preparing).toBe(f.repo);
    expect(await exists(lease)).toBe(false);
  } finally {
    await holder.stop();
    await f.close();
  }
});

test("Clear stale lock reports what holds the lock, and only reports clearing one it retired", async () => {
  const f = await fixture();
  const holder = await holdGit(f.repo);
  const clear = (id: string) =>
    f.runtime.execute(
      Command.parse({
        id,
        deviceId: "device",
        payload: { type: "git.lock.clear", threadId: f.thread.id },
      }),
    );
  try {
    const lease = await leftLease(f.repo, f.repo);
    expect(await clear("clear-held")).toMatchObject({
      ok: false,
      error: "git_quarantined",
      locksCleared: 0,
      detail: expect.stringContaining(`pid ${holder.pid}`),
    });
    expect(await exists(lease)).toBe(true);
    await holder.stop();
    expect(await clear("clear-free")).toMatchObject({ ok: true, locksCleared: 1 });
    expect(await exists(lease)).toBe(false);
    expect(await clear("clear-nothing")).toMatchObject({ ok: true, locksCleared: 0 });
  } finally {
    await holder.stop();
    await f.close();
  }
});
