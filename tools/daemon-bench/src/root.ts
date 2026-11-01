import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BenchRoot } from "./daemon.ts";
import { installFakeCli } from "./fake-cli/install.ts";

/**
 * A throwaway root with a fake HOME, the fake claude CLI and a git project. The daemon refuses
 * projects in system folders, and macOS temp lives under /var, so macOS uses /tmp.
 */
export async function makeBenchRoot(prefix = "ace-daemon-bench-") {
  const base = process.platform === "darwin" ? "/tmp" : tmpdir();
  const directory = await mkdtemp(join(base, prefix));
  const root: BenchRoot = {
    home: join(directory, "home"),
    aceHome: join(directory, "home/.ace-bench"),
    bin: join(directory, "bin"),
    project: join(directory, "home/project"),
    tmp: join(directory, "tmp"),
  };
  for (const path of [root.aceHome, root.project, root.tmp]) await mkdir(path, { recursive: true });
  await installFakeCli(root.bin, "claude");
  await project(root);
  return { directory, root };
}

/** Projects are git repositories; git is the one real tool beside the fake CLI on PATH. */
async function project(root: BenchRoot) {
  const run = promisify(execFile);
  const { stdout } = await run("/bin/sh", ["-c", "command -v git"]);
  await symlink(stdout.trim(), join(root.bin, "git"));
  const env = { PATH: root.bin, HOME: root.home, GIT_CONFIG_NOSYSTEM: "1" };
  await writeFile(join(root.project, "README.md"), "# Benchmark project\n");
  const git = (...args: string[]) => run("git", args, { cwd: root.project, env });
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".");
  await git(
    "-c",
    "user.name=bench",
    "-c",
    "user.email=bench@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Start",
  );
}
