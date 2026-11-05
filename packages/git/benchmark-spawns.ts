// What a Git spawn costs the daemon's thread: N `git status` calls through GitService, C at a
// time, started with Bun.spawn (today) or node:child_process (before). Real Git on a fixture
// repository under a temporary HOME.
//
//   bun packages/git/benchmark-spawns.ts [calls=200] [concurrency=20]
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { GitService, spawnGitProcess, type GitProcessRuntime } from "./src/index.ts";

const calls = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.argv[2] ?? 200);
const concurrency = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.argv[3] ?? 20);
const home = await mkdtemp(join(tmpdir(), "ace-git-spawn-benchmark-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
const repo = join(home, "repo");
const run = promisify(execFile);
await run("git", ["init", "-q", "-b", "main", repo]);
for (let index = 0; index < 50; index++) await writeFile(join(repo, `f${index}.txt`), `${index}\n`);
await run("git", ["-C", repo, "add", "-A"]);
await run("git", ["-C", repo, "-c", "user.name=B", "-c", "user.email=b@b", "commit", "-qm", "x"]);
await writeFile(join(repo, "f0.txt"), "changed\n");
await mkdir(join(repo, "new"));
await writeFile(join(repo, "new", "untracked.txt"), "new\n");

const quantile = (values: number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;

async function measure(label: string, start: GitProcessRuntime["spawn"]) {
  const blocked: number[] = [];
  const service = new GitService({
    processRuntime: {
      spawn(command, args, options) {
        const before = performance.now();
        const child = start(command, args, options);
        blocked.push(performance.now() - before);
        return child;
      },
    },
  });
  for (let index = 0; index < 10; index++) await service.status(repo);
  blocked.length = 0;
  // How late a 1 ms timer fires: the longest the thread was busy with anything else.
  const lags: number[] = [];
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 1);
    last = now;
  }, 1);
  const cpu = process.cpuUsage();
  const began = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < calls) await service.status(repo);
    }),
  );
  const wall = performance.now() - began;
  const used = process.cpuUsage(cpu);
  clearInterval(beat);
  await service.close();
  const average = blocked.reduce((sum, value) => sum + value, 0) / blocked.length;
  const cpuMs = (used.user + used.system) / 1000;
  console.log(
    `${label.padEnd(14)} ${blocked.length} spawns, wall ${wall.toFixed(0)} ms, thread CPU ${cpuMs.toFixed(0)} ms ` +
      `(${(cpuMs / blocked.length).toFixed(2)} per spawn), ` +
      `spawn call avg ${average.toFixed(2)} p99 ${quantile(blocked, 0.99).toFixed(2)} max ${quantile(blocked, 1).toFixed(2)} ms, ` +
      `timer lag p99 ${quantile(lags, 0.99).toFixed(1)} max ${quantile(lags, 1).toFixed(1)} ms`,
  );
}

console.log(
  `${calls} git status calls, ${concurrency} at a time; load ${loadavg()[0]?.toFixed(0)}`,
);
try {
  for (let round = 0; round < 5; round++) {
    await measure("child_process", (command, args, options) =>
      spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }),
    );
    await measure("Bun.spawn", spawnGitProcess);
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
