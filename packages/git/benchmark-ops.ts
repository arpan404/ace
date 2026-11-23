// Where a GitService call's time goes: Git processes spawned per call, wall time, the daemon's
// own CPU and the Git children's CPU, for the calls the daemon makes most. Non-gating.
//
//   node packages/git/benchmark-ops.ts [source-repository] [--calls=20] [--only=status,branches]
//     [--output=result.json]
//
// It clones `source-repository` (default: the current directory's repository) into a temporary
// directory with `git clone --local`, edits 20 tracked files, stages 5 and adds 10 untracked
// ones, and runs every call against the clone. The source is only read. HOME, XDG_CONFIG_HOME
// and the system config are isolated, so the person's Git configuration and credentials are
// never read. Children's CPU is measured per call kind by running it in a child process under
// `/usr/bin/time` (getrusage of waited-for children) less an empty run of the same process.
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { GitService, spawnGitProcess } from "./src/index.ts";

const run = promisify(execFile);
const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const round = (value: number) => Math.round(value * 100) / 100;

type Call = (git: GitService, root: string) => Promise<unknown>;
const calls: Record<string, Call> = {
  "empty (process baseline)": async () => {},
  "one trivial git (rev-parse HEAD)": (_git, root) =>
    run("git", ["-C", root, "rev-parse", "HEAD"]).then(() => undefined),
  repositoryInfo: (git, root) => git.repositoryInfo(root),
  status: (git, root) => git.status(root),
  sourceControlState: (git, root) => git.sourceControlState(root),
  changedFiles: (git, root) => git.changedFiles(root),
  checkoutSummary: (git, root) => git.checkoutSummary(root),
  listWorktrees: (git, root) => git.listWorktrees(root),
  branches: (git, root) => git.branches(root),
  branchRefs: (git, root) => git.branchRefs(root),
  "resolveCommit HEAD": (git, root) => git.resolveCommit({ worktree: root, ref: "HEAD" }),
  branchHead: (git, root) => git.branchHead({ repo: root, branch: "bench" }),
  "diff HEAD → working tree": (git, root) =>
    git.diff({
      worktree: root,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    }),
  "diffCommit HEAD (one file)": async (git, root) =>
    git.diffCommit({
      worktree: root,
      commit: await git.resolveCommit({ worktree: root, ref: "HEAD" }),
      paths: ["package.json"],
    }),
  "fileLog package.json": (git, root) =>
    git.fileLog({ worktree: root, path: "package.json", limit: 50 }),
  readRevisionLines: (git, root) =>
    git.readRevisionLines({
      worktree: root,
      revision: { kind: "commit", ref: "HEAD" },
      path: "package.json",
      start: 1,
      end: 50,
    }),
  workspaceRevision: (git, root) => git.workspaceRevision(root),
  createCheckpoint: (git, root) =>
    git.createCheckpoint({ worktree: root, threadId: "bench", label: "bench" }),
};

type Sample = {
  call: string;
  calls: number;
  spawnsPerCall: number;
  byCommand: Record<string, number>;
  /** Wall time per call spent inside each Git command, summed over its spawns. */
  wallMsByCommand: Record<string, number>;
  wallMsMedian: number;
  wallMsP90: number;
  gitWallMsPerCall: number;
  daemonCpuMsPerCall: number;
};

async function measure(root: string, name: string, count: number): Promise<Sample> {
  const call = calls[name];
  if (!call) throw new Error(`Unknown call ${name}`);
  const spawned: string[] = [];
  const commandWall: Record<string, number> = {};
  let gitWall = 0;
  const git = new GitService({
    processRuntime: {
      spawn(binary, args, options) {
        const plain = args.filter((arg) => arg !== "--no-pager");
        let index = 0;
        while (plain[index] === "-c" || plain[index] === "-C") index += 2;
        const command =
          `${plain[index] ?? "?"} ${plain[index + 1]?.startsWith("-") ? "" : (plain[index + 1] ?? "")}`.trim();
        spawned.push(command);
        const started = performance.now();
        const child = spawnGitProcess(binary, args, options);
        child.once("close", () => {
          const took = performance.now() - started;
          gitWall += took;
          commandWall[command] = (commandWall[command] ?? 0) + took;
        });
        return child;
      },
    },
  });
  await call(git, root); // warm: discovery, caches, page cache
  spawned.length = 0;
  gitWall = 0;
  for (const key of Object.keys(commandWall)) delete commandWall[key];
  const walls: number[] = [];
  const cpu = process.cpuUsage();
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await call(git, root);
    walls.push(performance.now() - started);
  }
  const used = process.cpuUsage(cpu);
  await git.close();
  walls.sort((a, b) => a - b);
  const byCommand: Record<string, number> = {};
  for (const command of spawned) byCommand[command] = (byCommand[command] ?? 0) + 1 / count;
  return {
    call: name,
    calls: count,
    spawnsPerCall: round(spawned.length / count),
    byCommand: Object.fromEntries(
      Object.entries(byCommand).map(([key, value]) => [key, round(value)]),
    ),
    wallMsByCommand: Object.fromEntries(
      Object.entries(commandWall).map(([key, value]) => [key, round(value / count)]),
    ),
    wallMsMedian: round(walls[Math.floor(count / 2)] ?? 0),
    wallMsP90: round(walls[Math.floor(count * 0.9)] ?? 0),
    gitWallMsPerCall: round(gitWall / count),
    daemonCpuMsPerCall: round((used.user + used.system) / 1000 / count),
  };
}

/** User+system CPU of this process and every child it waited for, in ms (BSD/GNU time). */
async function timed(args: string[]): Promise<{ cpuMs: number; stdout: string }> {
  const gnu = process.platform === "linux";
  const child = spawn("/usr/bin/time", [gnu ? "-v" : "-l", process.execPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await new Promise((resolve) => child.once("close", resolve));
  const seconds = (pattern: RegExp) => Number(pattern.exec(stderr)?.[1] ?? Number.NaN);
  const cpu = gnu
    ? seconds(/User time \(seconds\): ([\d.]+)/) + seconds(/System time \(seconds\): ([\d.]+)/)
    : seconds(/([\d.]+) user/) + seconds(/([\d.]+) sys/);
  return { cpuMs: cpu * 1000, stdout };
}

if (process.argv.includes("--child")) {
  const [root, name, count] = positional;
  if (!root || !name) throw new Error("child needs root and call");
  try {
    process.stdout.write(JSON.stringify(await measure(root, name, Number(count))));
  } catch (error) {
    process.stdout.write(JSON.stringify({ call: name, error: String(error) }));
  }
} else {
  const count = Number(flag("calls") ?? 20);
  const source = await realpath(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.cwd(),
  );
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-git-ops-")));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const repo = join(home, "repo");
  const git = (...args: string[]) =>
    run(
      "git",
      ["-C", repo, "-c", "user.name=Bench", "-c", "user.email=bench@ace.invalid", ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  try {
    await run("git", ["clone", "-q", "--local", source, repo], { maxBuffer: 64 * 1024 * 1024 });
    await git("branch", "bench");
    const all = (await git("ls-files")).stdout.split("\n").filter(Boolean);
    const tracked = all.filter((path) => path.endsWith(".ts"));
    const edited = tracked
      .filter((_, index) => index % Math.max(1, Math.floor(tracked.length / 20)) === 0)
      .slice(0, 20);
    for (const path of edited)
      await writeFile(join(repo, path), `${await readFile(join(repo, path), "utf8")}\n// edit\n`);
    await git("add", "--", ...edited.slice(0, 5));
    await mkdir(join(repo, "bench-untracked"));
    for (let index = 0; index < 10; index++)
      await writeFile(
        join(repo, "bench-untracked", `u${index}.ts`),
        `export const u = ${index};\n`,
      );
    const commits = (await git("rev-list", "--count", "HEAD")).stdout.trim();
    const results: (Sample & { childCpuMsPerCall: number })[] = [];
    const baseline = await timed([
      import.meta.filename,
      "--child",
      repo,
      "empty (process baseline)",
      String(count),
    ]);
    const only = flag("only")?.split(",");
    for (const name of Object.keys(calls).filter((call) => !only || only.includes(call))) {
      const { cpuMs, stdout } = await timed([
        import.meta.filename,
        "--child",
        repo,
        name,
        String(count),
      ]);
      const sample = JSON.parse(stdout) as Sample & { error?: string };
      if (sample.error) {
        process.stderr.write(`${name}: failed: ${sample.error}\n`);
        continue;
      }
      const children = (cpuMs - baseline.cpuMs) / (count + 1) - sample.daemonCpuMsPerCall;
      results.push({ ...sample, childCpuMsPerCall: Math.max(0, Math.round(children * 100) / 100) });
      process.stderr.write(`${name}: ${sample.wallMsMedian} ms, ${sample.spawnsPerCall} spawns\n`);
    }
    const report = {
      host: {
        platform: process.platform,
        node: process.version,
        load: (await run("uptime")).stdout.trim(),
      },
      repository: { trackedFiles: all.length, commits, edited: 20, staged: 5, untracked: 10 },
      results,
    };
    const output = flag("output");
    if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
