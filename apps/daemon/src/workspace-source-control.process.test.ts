import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("names ace's private entries in each known checkout's local exclude when the daemon opens", async () => {
    const { runtime, store, repo } = await setupFixture();
    try {
      await runtime.excludePrivateEntries();
      expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toContain(
        ".ace-upload-*",
      );
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("a staged-only commit takes exactly what is staged, leaving other edits in the checkout", async () => {
    const { runtime, store, thread, repo, cmd } = await setupFixture();
    try {
      await writeFile(join(repo, "file.txt"), "staged\n");
      await writeFile(join(repo, "other.txt"), "not staged\n");
      expect(
        await runtime.execute(cmd({ type: "git.stage", threadId: thread.id, paths: ["file.txt"] })),
      ).toMatchObject({ ok: true });
      await writeFile(join(repo, "file.txt"), "staged, then edited\n");
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      const done = await runtime.execute(
        cmd({
          type: "git.commit",
          threadId: thread.id,
          message: "only the index",
          expectedHead: head,
          stagedOnly: true,
        }),
      );
      expect(done).toMatchObject({ ok: true });
      expect(runGit(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("file.txt");
      expect(runGit(repo, ["show", "HEAD:file.txt"])).toBe("staged");
      expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("staged, then edited\n");
      expect(runGit(repo, ["status", "--porcelain", "--", "other.txt"])).toBe("?? other.txt");
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("serves git.status sections and the staged and unstaged diff of one file", async () => {
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
    } finally {
      await runtime.close();
      store.close();
    }
  });
});
