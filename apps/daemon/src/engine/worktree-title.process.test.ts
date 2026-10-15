import { commandContext } from "../commands.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { requestedBase, requestedBaseKey } from "../worktree-base.ts";
import { nameWorktreeBranch, runWorktreeGit } from "./worktree-title.ts";
const exec = promisify(execFile);
test("fresh worktree branches use deduplicated title slugs instead of random IDs", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const repo = join(h.home, "repo");
    await mkdir(repo);
    const git = async (...args: string[]) =>
      (await exec("git", ["-C", repo, ...args])).stdout.trim();
    await git("init", "-b", "main");
    await git("config", "user.email", "tests@example.com");
    await git("config", "user.name", "Tests");
    await writeFile(join(repo, "readme.txt"), "initial\n");
    await git("add", "readme.txt");
    await git("commit", "-m", "initial");
    await git("branch", "ace/fix-login");
    const workspace = h.store.createWorkspace(repo, "project");
    for (const [index, char] of ["a", "b"].entries()) {
      const id = ThreadId.parse(`tree-${index}`),
        path = join(h.home, `work-${index}`),
        branch = `ace/${char.repeat(24)}`;
      await git("worktree", "add", "-b", branch, path, "main");
      const command = Command.parse({
        id: `create-${index}`,
        deviceId: "device",
        payload: {
          type: "thread.create",
          threadId: id,
          workspaceId: workspace,
          provider: "codex",
          mode: "worktree",
          baseBranch: "main",
          input: [{ type: "text", text: "Fix login" }],
        },
      });
      expect(
        h.store.recordCommand(command.id, command.deviceId, () =>
          h.engine.handler.handle(command, {
            ...commandContext(h.store),
            preparedWorkspace: {
              id,
              path,
              branch,
              project: repo,
              requestedBase: requestedBaseKey(requestedBase({ baseBranch: "main" })),
            },
          }),
        ),
      ).toMatchObject({ ok: true });
      await h.engine.flush();
      expect(h.store.getThread(id)?.details?.branch).toBe(`ace/fix-login-${index + 2}`);
      expect((await exec("git", ["-C", path, "branch", "--show-current"])).stdout.trim()).toBe(
        `ace/fix-login-${index + 2}`,
      );
    }
  } finally {
    await h.close();
  }
});

async function setupRepo(home: string) {
  const repo = join(home, "repo");
  await mkdir(repo);
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "tests@example.com");
  await git("config", "user.name", "Tests");
  await writeFile(join(repo, "readme.txt"), "initial\n");
  await git("add", "readme.txt");
  await git("commit", "-m", "initial");
  return { repo, git };
}

async function createWorktreeThread(
  h: Awaited<ReturnType<typeof harness>>,
  repo: string,
  workspace: string,
  index: number,
  input = "Fix the reconnect behavior for flaky networks",
) {
  const id = ThreadId.parse(`branch-${index}`);
  const path = join(h.home, `model-work-${index}`);
  const branch = `ace/${"c".repeat(23)}${index}`;
  await exec("git", ["-C", repo, "worktree", "add", "-b", branch, path, "main"]);
  const command = Command.parse({
    id: `create-branch-${index}`,
    deviceId: "device",
    payload: {
      type: "thread.create",
      threadId: id,
      workspaceId: workspace,
      provider: "codex",
      mode: "worktree",
      baseBranch: "main",
      input: [{ type: "text", text: input }],
    },
  });
  expect(
    h.store.recordCommand(command.id, command.deviceId, () =>
      h.engine.handler.handle(command, {
        ...commandContext(h.store),
        preparedWorkspace: {
          id,
          path,
          branch,
          project: repo,
          requestedBase: requestedBaseKey(requestedBase({ baseBranch: "main" })),
        },
      }),
    ),
  ).toMatchObject({ ok: true });
  // Admission only: do not flush sends, so the branch stays provisional for direct rename tests.
  return { id, path, branch };
}

function worktreeGit() {
  return (cwd: string, args: string[]) => runWorktreeGit(exec, process.env, cwd, args);
}

test("a model slug renames the provisional branch to a concise name", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const { repo } = await setupRepo(h.home);
    const workspace = h.store.createWorkspace(repo, "project");
    const { id, path } = await createWorktreeThread(h, repo, workspace, 1);
    await nameWorktreeBranch(h.store, id, h.clock.now(), worktreeGit(), "fix-reconnect");
    expect(h.store.getThread(id)?.details?.branch).toBe("ace/fix-reconnect");
    expect((await exec("git", ["-C", path, "branch", "--show-current"])).stdout.trim()).toBe(
      "ace/fix-reconnect",
    );
  } finally {
    await h.close();
  }
});

test("a late model slug upgrades a title-slug branch", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const { repo } = await setupRepo(h.home);
    const workspace = h.store.createWorkspace(repo, "project");
    const { id, path } = await createWorktreeThread(h, repo, workspace, 2);
    await h.engine.flush();
    const afterTitle = h.store.getThread(id)?.details?.branch;
    expect(afterTitle?.startsWith("ace/")).toBe(true);
    expect(afterTitle).not.toBe("ace/fix-reconnect");
    await nameWorktreeBranch(h.store, id, h.clock.now(), worktreeGit(), "fix-reconnect");
    expect(h.store.getThread(id)?.details?.branch).toBe("ace/fix-reconnect");
    expect((await exec("git", ["-C", path, "branch", "--show-current"])).stdout.trim()).toBe(
      "ace/fix-reconnect",
    );
  } finally {
    await h.close();
  }
});

test("model slug collisions fall back with a suffix and invalid slugs use the title", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const { repo, git } = await setupRepo(h.home);
    await git("branch", "ace/fix-reconnect");
    const workspace = h.store.createWorkspace(repo, "project");
    const first = await createWorktreeThread(h, repo, workspace, 3);
    await nameWorktreeBranch(h.store, first.id, h.clock.now(), worktreeGit(), "fix-reconnect");
    expect(h.store.getThread(first.id)?.details?.branch).toBe("ace/fix-reconnect-2");

    const second = await createWorktreeThread(h, repo, workspace, 4, "Fix login");
    await nameWorktreeBranch(
      h.store,
      second.id,
      h.clock.now(),
      worktreeGit(),
      "not a valid slug!!!",
    );
    expect(h.store.getThread(second.id)?.details?.branch).toBe("ace/fix-login");
  } finally {
    await h.close();
  }
});

test("user commits, upstreams and identity changes still fence a model rename", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const { repo } = await setupRepo(h.home);
    const workspace = h.store.createWorkspace(repo, "project");
    const { id, path, branch } = await createWorktreeThread(h, repo, workspace, 5);
    // Identity change: checkout moves away from the recorded branch.
    await exec("git", ["-C", path, "checkout", "-b", "ace/user-work"]);
    await nameWorktreeBranch(h.store, id, h.clock.now(), worktreeGit(), "fix-reconnect");
    expect(h.store.getThread(id)?.details?.branch).toBe(branch);
    await exec("git", ["-C", path, "checkout", branch]);

    // User commit: a second reflog entry fences the rename.
    await writeFile(join(path, "change.txt"), "user\n");
    await exec("git", ["-C", path, "add", "change.txt"]);
    await exec("git", ["-C", path, "commit", "-m", "user commit"]);
    await nameWorktreeBranch(h.store, id, h.clock.now(), worktreeGit(), "fix-reconnect");
    expect(h.store.getThread(id)?.details?.branch).toBe(branch);
  } finally {
    await h.close();
  }
});
