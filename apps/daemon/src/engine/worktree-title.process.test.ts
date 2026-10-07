import { commandContext } from "../commands.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { requestedBase, requestedBaseKey } from "../worktree-base.ts";
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
