import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, GitService, spawnGitProcess } from "@ace/git";
import { CommandId, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { git } from "./conductor/test-git.ts";

test("quarantine blocks workspace preparation and provider input until cleanup recovers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-git-quarantine-"));
  const root = join(home, "repo");
  await mkdir(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "Initial");
  const store = new Store(join(home, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Fixture",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const exited = Promise.withResolvers<void>();
  let inject = true;
  const service = new GitService({
    processRuntime: {
      spawn: (binary, args, options) => {
        if (!inject || !args.includes("read-tree")) return spawnGitProcess(binary, args, options);
        inject = false;
        // This fixture executable starts no descendants. It does not invoke a provider.
        const child = spawnGitProcess(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          options,
        );
        child.once("exit", () => exited.resolve());
        child.once("spawn", () =>
          child.stdout.destroy(Object.assign(new Error("Fixture EIO"), { code: "EIO" })),
        );
        return child;
      },
    },
  });
  const runtime = new WorkspaceRuntime(store, home, () => 1000, { gitService: service });
  try {
    const failure = await service
      .createCheckpoint({ worktree: root, threadId: "setup", label: "uncertain" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "filesystem_error", details: { errno: "EIO" } });
    if (!(failure instanceof GitError) || !failure.cleanup) throw new Error("Missing receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    await expect(runtime.prepare(thread.id)).rejects.toMatchObject({ code: "git_quarantined" });
    await expect(
      runtime.checkpoints.beforeSend(thread.id, CommandId.parse("blocked")),
    ).rejects.toMatchObject({ code: "git_quarantined" });
    await exited.promise;
    await new GitService({
      processRuntime: {
        cleanupSupervisor: {
          stop: () => {
            throw new Error("Recovery does not spawn");
          },
          recover: async () => ({
            status: "confirmed",
            evidence: "Exclusive fixture process without descendants exited",
          }),
        },
      },
    }).recoverCleanup(root);
    expect(await runtime.prepare(thread.id)).toBe(root);
    await expect(
      runtime.checkpoints.beforeSend(thread.id, CommandId.parse("recovered")),
    ).resolves.toBeUndefined();
    expect(await service.listCheckpoints({ repo: root, threadId: thread.id })).toMatchObject([
      { label: "Before recovered" },
    ]);
  } finally {
    await runtime.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
