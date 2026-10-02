import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitService } from "./src/index.ts";

const average = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);

const count = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(count) || count < 10)
  throw new Error("History count must be an integer of at least 10");
// Optional module path lets this same workload compare earlier versions of our service.
const Service: typeof GitService = process.argv[3]
  ? (await import(pathToFileURL(resolve(process.argv[3])).href)).GitService
  : GitService;
const repo = await mkdtemp(join(tmpdir(), "ace-git-history-benchmark-"));
const execute = promisify(execFile);
const git = (...args: string[]) =>
  execute("git", args, {
    cwd: repo,
    timeout: 120_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
try {
  await git("init", "-b", "main");
  await writeFile(join(repo, "file.txt"), "history benchmark\n");
  await git("add", "--all");
  await git(
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@ace.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initial",
  );
  const service = new Service();
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await service.createCheckpoint({ worktree: repo, threadId: "history", label: String(i) });
    times.push(performance.now() - start);
  }
  const listingStart = performance.now();
  const checkpoints = await service.listCheckpoints({ repo, threadId: "history" });
  process.stdout.write(
    JSON.stringify({
      checkpoints: checkpoints.length,
      firstTenAverageMs: average(times.slice(0, 10)),
      lastTenAverageMs: average(times.slice(-10)),
      totalAllocationMs: Math.round(times.reduce((a, b) => a + b, 0)),
      listingMs: Math.round(performance.now() - listingStart),
    }) + "\n",
  );
} finally {
  await rm(repo, { recursive: true, force: true });
}
