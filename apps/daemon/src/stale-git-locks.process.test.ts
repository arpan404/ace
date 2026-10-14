import { randomUUID } from "node:crypto";
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
async function leftLease(repo: string, root: string) {
  const journal = join(repo, ".git", "ace-mutation-leases");
  await mkdir(journal, { recursive: true });
  const id = randomUUID();
  const owner = { port: await stoppedDaemonPort(), token: randomUUID() };
  await writeFile(
    join(journal, id),
    JSON.stringify({ version: 1, id, root, owner, roots: [root] }),
  );
  return join(journal, id);
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

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

test("the startup sweep retires a stopped daemon's lease whose worktree is gone and keeps one whose worktree remains", async () => {
  const f = await fixture();
  try {
    const removed = join(f.home, "issue55");
    const kept = join(f.home, "kept");
    git(f.repo, "worktree", "add", "-b", "issue55", removed);
    git(f.repo, "worktree", "add", "-b", "kept", kept);
    const stale = await leftLease(f.repo, removed);
    const unsettled = await leftLease(f.repo, kept);
    git(f.repo, "worktree", "remove", "--force", removed);
    const failures: string[] = [];
    await f.runtime.sweepStaleLeases((path) => failures.push(path));
    expect(failures).toEqual([]);
    expect(await exists(stale)).toBe(false);
    expect(await exists(unsettled)).toBe(true);
    expect(f.retired).toMatchObject([
      { repository: f.repo, reason: "owner_gone_roots_settled", lease: { root: removed } },
    ]);
    // The remaining lease fences only its own worktree, not the project's checkout.
    expect(await f.runtime.prepare(f.thread.id)).toBe(f.repo);
  } finally {
    await f.close();
  }
});

test("Clear stale lock retires the lock fencing a thread's checkout so its next send can open", async () => {
  const f = await fixture();
  try {
    const lease = await leftLease(f.repo, f.repo);
    await expect(f.runtime.prepare(f.thread.id)).rejects.toMatchObject({
      code: "git_quarantined",
      message: expect.stringContaining("Clear stale lock"),
    });
    const result = await f.runtime.execute(
      Command.parse({
        id: "clear-lock",
        deviceId: "device",
        payload: { type: "git.lock.clear", threadId: f.thread.id },
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(await exists(lease)).toBe(false);
    expect(f.retired).toMatchObject([{ repository: f.repo, reason: "confirmed_stale" }]);
    expect(await f.runtime.prepare(f.thread.id)).toBe(f.repo);
  } finally {
    await f.close();
  }
});
