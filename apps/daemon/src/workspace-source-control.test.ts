import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, Thread, type ThreadId } from "@ace/protocol";
import type { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

async function setupFixture(
  options: {
    runsProviderWork?: (id: ThreadId) => boolean;
    trashFile?: (id: ThreadId, path: string) => Promise<void>;
    threadState?: "new" | "working";
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "ace-daemon-sc-"));
  tempDirs.push(dir);
  const repo = join(dir, "repo");
  const dataDir = join(dir, "data");
  await mkdtemp(join(dir, "keep-"));
  runGit(dir, ["init", "-b", "main", repo]);
  runGit(repo, ["config", "user.name", "Test User"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "file.txt"), "one\n");
  runGit(repo, ["add", "file.txt"]);
  runGit(repo, ["commit", "-m", "initial"]);

  const store = new Store(join(dir, "events.sqlite"));
  const workspaceId = store.createWorkspace(repo, "Repo");
  const thread = Thread.parse({
    id: "thread-sc",
    workspaceId,
    provider: "codex",
    title: "Source control thread",
    status: options.threadState === "working" ? { state: "working", agents: 1 } : { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, dataDir, () => 1000, {
    runsProviderWork: options.runsProviderWork ?? (() => false),
    ...(options.trashFile ? { trashFile: options.trashFile } : {}),
  });
  let seq = 0;
  const cmd = (payload: z.input<typeof Command>["payload"]) =>
    Command.parse({
      id: `cmd-${++seq}`,
      deviceId: "dev-1",
      createdAt: 1000 + seq,
      payload,
    });
  return { dir, repo, store, thread, runtime, cmd };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("daemon source control handlers", () => {
  it("refuses escaping or .git paths as typed command errors without throwing", async () => {
    const { runtime, store, thread, cmd } = await setupFixture();
    try {
      const stageEscape = await runtime.execute(
        cmd({ type: "git.stage", threadId: thread.id, paths: ["../outside.txt"] }),
      );
      expect(stageEscape).toMatchObject({ ok: false, error: "git_path_outside_repo" });

      const unstageAbs = await runtime.execute(
        cmd({ type: "git.unstage", threadId: thread.id, paths: ["/etc/passwd"] }),
      );
      expect(unstageAbs).toMatchObject({ ok: false, error: "git_path_outside_repo" });

      const discardGit = await runtime.execute(
        cmd({ type: "git.discard", threadId: thread.id, paths: [".git/config"] }),
      );
      expect(discardGit).toMatchObject({ ok: false, error: "git_path_outside_repo" });
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("refuses branch switch, branch create, and pull while an agent is working", async () => {
    let providerBusy = true;
    const { runtime, store, thread, repo, cmd } = await setupFixture({
      runsProviderWork: () => providerBusy,
    });
    try {
      runGit(repo, ["branch", "other"]);

      const switchBusy = await runtime.execute(
        cmd({ type: "git.branch.switch", threadId: thread.id, branch: "other" }),
      );
      expect(switchBusy).toMatchObject({ ok: false, error: "thread_tree_is_live" });

      const createBusy = await runtime.execute(
        cmd({ type: "git.branch.create", threadId: thread.id, branch: "feat/x" }),
      );
      expect(createBusy).toMatchObject({ ok: false, error: "thread_tree_is_live" });

      const pullBusy = await runtime.execute(cmd({ type: "git.pull", threadId: thread.id }));
      expect(pullBusy).toMatchObject({ ok: false, error: "thread_tree_is_live" });

      // Once idle, switching branches succeeds.
      providerBusy = false;
      const switchIdle = await runtime.execute(
        cmd({ type: "git.branch.switch", threadId: thread.id, branch: "other" }),
      );
      expect(switchIdle).toMatchObject({ ok: true });
      expect(runGit(repo, ["branch", "--show-current"])).toBe("other");
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("refuses branch switch when thread status is working even if runsProviderWork is false", async () => {
    const { runtime, store, thread, repo, cmd } = await setupFixture({
      runsProviderWork: () => false,
      threadState: "working",
    });
    try {
      runGit(repo, ["branch", "other"]);
      const result = await runtime.execute(
        cmd({ type: "git.branch.switch", threadId: thread.id, branch: "other" }),
      );
      expect(result).toMatchObject({ ok: false, error: "thread_tree_is_live" });
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("routes untracked discard through trashFile and refuses when trashFile is unavailable", async () => {
    const trashed: string[] = [];
    const trashDir = await mkdtemp(join(tmpdir(), "ace-daemon-trash-"));
    tempDirs.push(trashDir);
    let repoPath = "";
    const withTrash = await setupFixture({
      trashFile: async (_id, path) => {
        trashed.push(path);
        await rename(join(repoPath, path), join(trashDir, path));
      },
    });
    repoPath = withTrash.repo;
    try {
      await writeFile(join(withTrash.repo, "scratch.txt"), "keep me in trash\n");
      const ok = await withTrash.runtime.execute(
        withTrash.cmd({
          type: "git.discard",
          threadId: withTrash.thread.id,
          paths: ["scratch.txt"],
        }),
      );
      expect(ok).toMatchObject({ ok: true });
      expect(trashed).toEqual(["scratch.txt"]);
      expect(await readFile(join(trashDir, "scratch.txt"), "utf8")).toBe("keep me in trash\n");
    } finally {
      await withTrash.runtime.close();
      await withTrash.store.close();
    }

    const withoutTrash = await setupFixture();
    try {
      await writeFile(join(withoutTrash.repo, "scratch.txt"), "do not delete\n");
      const refused = await withoutTrash.runtime.execute(
        withoutTrash.cmd({
          type: "git.discard",
          threadId: withoutTrash.thread.id,
          paths: ["scratch.txt"],
        }),
      );
      expect(refused).toMatchObject({ ok: false, error: "git_trash_unavailable" });
      expect(await readFile(join(withoutTrash.repo, "scratch.txt"), "utf8")).toBe(
        "do not delete\n",
      );
    } finally {
      await withoutTrash.runtime.close();
      await withoutTrash.store.close();
    }
  });

  it("serves enriched git.status, git.branches, git.diff stage views, and stash commands", async () => {
    const { runtime, store, thread, repo, cmd } = await setupFixture();
    try {
      await writeFile(join(repo, "file.txt"), "staged\n");
      expect(
        await runtime.execute(cmd({ type: "git.stage", threadId: thread.id, paths: ["file.txt"] })),
      ).toMatchObject({ ok: true });
      await writeFile(join(repo, "file.txt"), "unstaged\n");

      const statusRes = await runtime.read({
        type: "workspace.request",
        requestId: "r-status",
        operation: { op: "git.status", threadId: thread.id },
      });
      expect(statusRes.result).toMatchObject({
        kind: "gitStatus",
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: [{ path: "file.txt", status: "modified" }],
        unstaged: [{ path: "file.txt", status: "modified" }],
      });

      const stagedDiff = await runtime.read({
        type: "workspace.request",
        requestId: "r-diff-staged",
        operation: { op: "git.diff", threadId: thread.id, path: "file.txt", stage: "staged" },
      });
      expect(stagedDiff.result.kind).toBe("gitDiff");
      if (stagedDiff.result.kind === "gitDiff") {
        expect(stagedDiff.result.patch).toContain("+staged");
        expect(stagedDiff.result.patch).not.toContain("+unstaged");
      }

      const unstagedDiff = await runtime.read({
        type: "workspace.request",
        requestId: "r-diff-unstaged",
        operation: { op: "git.diff", threadId: thread.id, path: "file.txt", stage: "unstaged" },
      });
      expect(unstagedDiff.result.kind).toBe("gitDiff");
      if (unstagedDiff.result.kind === "gitDiff") {
        expect(unstagedDiff.result.patch).toContain("+unstaged");
      }

      const branchesRes = await runtime.read({
        type: "workspace.request",
        requestId: "r-branches",
        operation: { op: "git.branches", threadId: thread.id },
      });
      expect(branchesRes.result).toMatchObject({
        kind: "branches",
        current: "main",
        detached: false,
      });

      expect(
        await runtime.execute(
          cmd({
            type: "git.stash.push",
            threadId: thread.id,
            message: "wip",
            includeUntracked: false,
          }),
        ),
      ).toMatchObject({ ok: true });

      const stashRes = await runtime.read({
        type: "workspace.request",
        requestId: "r-stashes",
        operation: { op: "git.stash.list", threadId: thread.id },
      });
      expect(stashRes.result).toMatchObject({
        kind: "gitStashes",
        stashes: [{ ref: "stash@{0}", index: 0, message: "wip", branch: "main" }],
      });

      expect(
        await runtime.execute(cmd({ type: "git.stash.pop", threadId: thread.id })),
      ).toMatchObject({ ok: true });
    } finally {
      await runtime.close();
      store.close();
    }
  });
});
