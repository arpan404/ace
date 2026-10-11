import { watch } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "@ace/git";
import { setup } from "./publication-project-test-support.ts";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

for (const phase of ["adding origin", "pushing"] as const) {
  test(`preferences changed during Git metadata before ${phase} prevent the effect`, async () => {
    const held = gate();
    let probes = 0;
    let resume: (() => void) | undefined;
    const f = await setup(
      {},
      {
        git: {
          processRuntime: {
            spawn(command, args, options) {
              const child = spawnGitProcess(command, args, options);
              if (
                args.includes("rev-parse") &&
                args.includes("--verify") &&
                args.includes("HEAD") &&
                ++probes === (phase === "adding origin" ? 2 : 3)
              ) {
                const pid = child.pid;
                if (pid === undefined) throw new Error("Missing Git process");
                // Stop a real process at the metadata edge; provider data and Git effects stay real.
                process.kill(-pid, "SIGSTOP");
                resume = () => {
                  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
                    return;
                  try {
                    process.kill(-child.pid, "SIGCONT");
                  } catch {
                    /* Already exited. */
                  }
                };
                held.open();
              }
              return child;
            },
          },
        },
      },
    );
    try {
      const remote = join(f.root, "remote.git");
      await mkdir(remote);
      await f.git(remote, ["init", "--bare"]);
      await appendFile(
        join(f.root, "gitconfig"),
        `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`,
      );
      await writeFile(join(f.path, "readme"), "safe");
      await f.git(f.path, ["add", "readme"]);
      await f.git(f.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Initial",
      ]);
      const pending = f.publish();
      await held.promise;
      await f.cli.settings.set(
        "sourceControl.preferences",
        { hosts: [{ host: "github.com", account: "other" }], host: "github.com", remote: "origin" },
        { kind: "global" },
      );
      expect(await pending).toMatchObject({
        ok: false,
        error: "forge_preferences_changed",
        publication: { remote: { id: 1 } },
      });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe(
        phase === "adding origin" ? "" : "origin",
      );
    } finally {
      resume?.();
      await f.cleanup();
    }
  });
}

function fileReady(path: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(path, check);
    function check() {
      void readFile(join(path, name)).then(
        () => {
          watcher.close();
          resolve();
        },
        () => {},
      );
    }
    check();
  });
}

test("a publication queued behind another Git operation cannot add origin after preferences change", async () => {
  const f = await setup();
  const git = new GitService();
  const directory = await open(f.path, "r");
  try {
    await writeFile(
      join(f.path, "hold.cjs"),
      `
const fs = require('node:fs');
fs.writeFileSync('.held', 'held');
const watcher = fs.watch('.', () => { if (fs.existsSync('.release')) watcher.close(); });
if (fs.existsSync('.release')) watcher.close();
`,
    );
    const owner = git.setupWorktree({ worktree: f.path, command: "node hold.cjs" });
    await fileReady(f.path, ".held");
    const guard = await f.cli.source.guard();
    const pending = git.attachPublicationOrigin({
      worktree: f.path,
      directoryFd: directory.fd,
      signal: new AbortController().signal,
      url: "https://github.com/octo/engine.git",
      guard,
    });
    // The queued operation's rejection is observed immediately to avoid an unhandled rejection.
    const rejected = expect(pending).rejects.toThrow();
    await f.cli.settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "github.com", account: "other" }],
        host: "github.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    await writeFile(join(f.path, ".release"), "release");
    await owner;
    await rejected;
    expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe("");
  } finally {
    await writeFile(join(f.path, ".release"), "release");
    await git.close();
    await directory.close();
    await f.cleanup();
  }
});
