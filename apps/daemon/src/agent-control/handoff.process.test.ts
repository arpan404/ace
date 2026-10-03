import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { GitService } from "@ace/git";
import { daemonFixture } from "./daemon-test-support.ts";

const runGit = promisify(execFile);
async function initialize(repo: string) {
  await runGit("git", ["init"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "handoff test\n");
  await runGit("git", ["add", "README.md"], { cwd: repo });
  await runGit(
    "git",
    ["-c", "user.name=ace", "-c", "user.email=ace@example.invalid", "commit", "-m", "initial"],
    { cwd: repo },
  );
}
async function assertNoResources(f: Awaited<ReturnType<typeof daemonFixture>>) {
  expect(
    (await runGit("git", ["worktree", "list", "--porcelain"], { cwd: f.h.home })).stdout.match(
      /^worktree /gm,
    ),
  ).toHaveLength(1);
  expect(
    (await runGit("git", ["branch", "--list", "ace-rejected*"], { cwd: f.h.home })).stdout,
  ).toBe("");
  expect(
    f.daemon.store.atomic((db) =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()?.n),
    ),
  ).toBe(1);
}

test("handoff capacity rejection creates no branch, worktree or workspace", async () => {
  const f = await daemonFixture({ policy: { maxConcurrent: 1 } });
  try {
    await initialize(f.h.home);
    await f.call({
      op: "delegate_task",
      requestId: "full",
      provider: "claude",
      task: "hold",
      role: "worker",
      wait: false,
      estimatedLoad: 0,
    });
    await f.daemon.engine?.flush();
    for (let i = 0; i < 3; i++)
      await expect(
        f.call({
          op: "thread.handoff",
          threadId: f.caller.threadId,
          requestId: `rejected-${i}`,
          branch: `ace-rejected-${i}`,
        }),
      ).rejects.toThrow(/concurrency/);
    await assertNoResources(f);
    expect(f.daemon.store.listThreads()).toHaveLength(2);
  } finally {
    await f.daemon.close();
  }
});

test("lease revocation while Git is pending cleans resources without accepting child work", async () => {
  const entered = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const f = await daemonFixture({
    policy: { maxConcurrent: 1 },
    handoffGit: () => {
      const git = new GitService();
      return {
        listWorktrees: git.listWorktrees.bind(git),
        removeWorktree: git.removeWorktree.bind(git),
        deleteBranch: git.deleteBranch.bind(git),
        resolveCommit: git.resolveCommit.bind(git),
        close: git.close.bind(git),
        async createWorktree(options) {
          const result = await git.createWorktree(options);
          entered.resolve();
          await ready.promise;
          return result;
        },
      };
    },
  });
  const controller = new AbortController();
  try {
    await initialize(f.h.home);
    const pending = f.controls.port.execute(
      f.caller,
      {
        op: "thread.handoff",
        threadId: f.caller.threadId,
        requestId: "revoked",
        branch: "ace-rejected-revoked",
      },
      controller.signal,
    );
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    await expect(
      f.call({
        op: "delegate_task",
        requestId: "while-reserved",
        provider: "claude",
        task: "work",
        role: "worker",
        wait: false,
        estimatedLoad: 0,
      }),
    ).rejects.toThrow(/concurrency/);
    controller.abort();
    ready.resolve();
    await rejection;
    await f.daemon.engine?.flush();
    await assertNoResources(f);
    expect(f.daemon.store.listThreads()).toHaveLength(1);
    // Cleanup releases the reservation so a fresh request can use the slot.
    const next = await f.call({
      op: "delegate_task",
      requestId: "after-revoke",
      provider: "claude",
      task: "work",
      role: "worker",
      wait: false,
      estimatedLoad: 0,
    });
    expect(next.ok).toBe(true);
  } finally {
    ready.resolve();
    await f.daemon.close();
  }
});

test("failed Git creation releases reserved capacity and preserves preexisting branches", async () => {
  const f = await daemonFixture({ policy: { maxConcurrent: 1 } });
  try {
    await initialize(f.h.home);
    await runGit("git", ["branch", "existing"], { cwd: f.h.home });
    await expect(
      f.call({
        op: "thread.handoff",
        threadId: f.caller.threadId,
        requestId: "failure",
        branch: "existing",
      }),
    ).rejects.toThrow();
    expect(
      (await runGit("git", ["branch", "--list", "existing"], { cwd: f.h.home })).stdout,
    ).toContain("existing");
    await assertNoResources(f);
    expect(
      (
        await f.call({
          op: "delegate_task",
          requestId: "after-failure",
          provider: "claude",
          task: "work",
          role: "worker",
          wait: false,
          estimatedLoad: 0,
        })
      ).ok,
    ).toBe(true);
  } finally {
    await f.daemon.close();
  }
});

test("maintenance rejects prepared launches and handoff retries at the trusted owner", async () => {
  const f = await daemonFixture();
  try {
    await initialize(f.h.home);
    const first = await f.call({
      op: "thread.handoff",
      threadId: f.caller.threadId,
      requestId: "maintenance-handoff",
      branch: "ace-ready",
    });
    expect(first.ok).toBe(true);
    await f.daemon.engine?.flush();
    const prepared = f.controls.delegations.prepare(f.caller, {
      requestId: "maintenance-prepared",
      provider: "claude",
      task: "hold",
      role: "worker",
      wait: false,
      estimatedLoad: 0,
    });
    f.daemon.maintenance.enter();
    await expect(
      f.call({
        op: "thread.launch",
        threadId: prepared.childId,
        requestId: "launch",
        text: "work",
      }),
    ).rejects.toThrow(/Admission closed/);
    await expect(
      f.call({
        op: "thread.handoff",
        threadId: f.caller.threadId,
        requestId: "maintenance-handoff",
        branch: "ace-ready",
      }),
    ).rejects.toThrow(/Admission closed/);
    await f.daemon.engine?.flush();
    expect(f.h.contexts.has(prepared.childId)).toBe(false);
  } finally {
    await f.daemon.close();
  }
});

test("cancelling the parent while a worktree is being created prevents child acceptance and cleans Git resources", async () => {
  const entered = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const f = await daemonFixture({
    handoffGit: () => {
      const git = new GitService();
      return {
        listWorktrees: git.listWorktrees.bind(git),
        removeWorktree: git.removeWorktree.bind(git),
        deleteBranch: git.deleteBranch.bind(git),
        resolveCommit: git.resolveCommit.bind(git),
        close: git.close.bind(git),
        async createWorktree(options) {
          const tree = await git.createWorktree(options);
          entered.resolve();
          await ready.promise;
          return tree;
        },
      };
    },
  });
  try {
    await initialize(f.h.home);
    const pending = f.call({
      op: "thread.handoff",
      threadId: f.caller.threadId,
      requestId: "parent-cancel",
      branch: "ace-rejected-parent",
    });
    const rejection = expect(pending).rejects.toThrow(/cancelled/);
    await entered.promise;
    f.controls.delegations.cancelDescendants(f.caller.threadId);
    ready.resolve();
    await rejection;
    await assertNoResources(f);
    expect(f.daemon.store.listThreads()).toHaveLength(1);
  } finally {
    ready.resolve();
    await f.daemon.close();
  }
});

test("revoked handoff cleanup preserves a user commit made in its pending worktree", async () => {
  const created = Promise.withResolvers<string>(),
    ready = Promise.withResolvers<void>();
  const f = await daemonFixture({
    policy: { maxConcurrent: 1 },
    handoffGit: () => {
      const git = new GitService();
      return {
        listWorktrees: git.listWorktrees.bind(git),
        removeWorktree: git.removeWorktree.bind(git),
        deleteBranch: git.deleteBranch.bind(git),
        resolveCommit: git.resolveCommit.bind(git),
        close: git.close.bind(git),
        async createWorktree(options) {
          const result = await git.createWorktree(options);
          created.resolve(result.path);
          await ready.promise;
          return result;
        },
      };
    },
  });
  const controller = new AbortController();
  try {
    await initialize(f.h.home);
    const pending = f.controls.port.execute(
      f.caller,
      {
        op: "thread.handoff",
        threadId: f.caller.threadId,
        requestId: "changed",
        branch: "ace-user-work",
      },
      controller.signal,
    );
    const rejection = expect(pending).rejects.toThrow(/identity changed/);
    const path = await created.promise;
    await writeFile(join(path, "README.md"), "user changed this worktree\n");
    await runGit(
      "git",
      ["-c", "user.name=ace", "-c", "user.email=ace@example.invalid", "commit", "-am", "user work"],
      { cwd: path },
    );
    const changed = (await runGit("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
    controller.abort();
    ready.resolve();
    await rejection;
    expect(
      (await runGit("git", ["rev-parse", "ace-user-work"], { cwd: f.h.home })).stdout.trim(),
    ).toBe(changed);
    expect(f.daemon.store.listThreads()).toHaveLength(1);
    // Failed safe cleanup remains bounded and cannot leak a sequence of new worktrees.
    await expect(
      f.call({
        op: "delegate_task",
        requestId: "while-cleanup-held",
        provider: "claude",
        task: "work",
        role: "worker",
        wait: false,
        estimatedLoad: 0,
      }),
    ).rejects.toThrow(/concurrency/);
  } finally {
    ready.resolve();
    await f.daemon.close();
  }
});
