import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { Command } from "@ace/protocol";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

for (const origin of [true, false]) {
  test(`a PR head reaches selected upstream ${origin ? "instead of the origin fork" : "when origin is absent"}`, async () => {
    const f = await forgeIdentityFixture();
    const git = promisify(execFile);
    let runtime: WorkspaceRuntime | undefined;
    try {
      await f.runtime.close();
      await git("git", ["-C", f.root, "config", "user.name", "Test"]);
      await git("git", ["-C", f.root, "config", "user.email", "test@example.invalid"]);
      await writeFile(join(f.root, "tracked"), "head");
      await git("git", ["-C", f.root, "add", "tracked"]);
      await git("git", ["-C", f.root, "commit", "-qm", "Initial"]);
      await git("git", ["-C", f.root, "switch", "-qc", "topic"]);
      if (!origin) await git("git", ["-C", f.root, "remote", "remove", "origin"]);
      const upstream = join(f.root, "upstream.git");
      const fork = join(f.root, "fork.git");
      for (const remote of [upstream, fork]) await git("git", ["init", "--bare", "-q", remote]);
      const config = join(f.root, "push.gitconfig");
      for (const { url, remote } of [
        { url: "git@git.example.com:octo/ace.git", remote: upstream },
        { url: "https://github.com/fork/ace.git", remote: fork },
      ]) {
        await git("git", [
          "config",
          "--file",
          config,
          `url.${pathToFileURL(remote).href}.insteadOf`,
          url,
        ]);
      }
      runtime = new WorkspaceRuntime(f.store, f.root, () => 1000, {
        sourceControl: f.sourceControl,
        git: {
          // The local bare remotes stand in for hosted ones through file URLs.
          transportProtocols: ["file"],
          processRuntime: {
            spawn(command, args, options) {
              return spawnGitProcess(command, args, {
                ...options,
                env: {
                  ...options.env,
                  ...(args.includes("push")
                    ? { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" }
                    : {}),
                },
              });
            },
          },
        },
      });
      const details = await runtime.details(f.thread.id);
      if (!details.head) throw new Error("Expected committed head");
      await f.update({ prHead: details.head });
      const target = { repository: details.repository, branch: details.branch, head: details.head };
      expect(
        await runtime.execute(
          Command.parse({
            id: "push-selected",
            deviceId: "device",
            payload: {
              type: "git.push",
              threadId: f.thread.id,
              remote: "upstream",
              target,
            },
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(
        (await git("git", ["--git-dir", upstream, "rev-parse", "refs/heads/topic"])).stdout.trim(),
      ).toBe(details.head);
      await expect(
        git("git", ["--git-dir", fork, "rev-parse", "--verify", "refs/heads/topic"]),
      ).rejects.toThrow();
      expect(
        await runtime.execute(
          Command.parse({
            id: "create-selected",
            deviceId: "device",
            payload: {
              type: "forge.pr.create",
              threadId: f.thread.id,
              repository: details.repository,
              input: {
                branch: "topic",
                base: "main",
                expectedHead: details.head,
                title: "Selected",
                summary: "Changes",
                draft: false,
                template: { title: "{{title}}", body: "{{summary}}" },
              },
            },
          }),
        ),
      ).toMatchObject({ ok: true, pr: { repository: details.repository, number: 7 } });
      // A changed branch/head cannot be pushed as the PR head the person reviewed.
      await git("git", ["-C", f.root, "commit", "--allow-empty", "-qm", "Moved"]);
      expect(
        await runtime.execute(
          Command.parse({
            id: "stale-push",
            deviceId: "device",
            payload: {
              type: "git.push",
              threadId: f.thread.id,
              remote: "upstream",
              target,
            },
          }),
        ),
      ).toMatchObject({ ok: false, error: "git_head_moved" });
    } finally {
      await runtime?.close();
      await f.close();
    }
  });
}
