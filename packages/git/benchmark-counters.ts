import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { z } from "zod";
import { GitService, spawnGitProcess, type GitProcessRuntime } from "./src/index.ts";

const count = z.coerce
  .number()
  .int()
  .min(256)
  .parse(process.argv[2] ?? 512);
if (!global.gc) throw new Error("Run with node --expose-gc benchmark-counters.ts [threads]");
const loadAtStart = loadavg();
const directory = await mkdtemp(join(tmpdir(), "ace-git-counter-benchmark-"));
const repo = join(directory, "repo");
const execute = promisify(execFile);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
// Keep both Git configuration and ace storage selectors inside the owned fixture.
Object.assign(environment, {
  HOME: directory,
  USERPROFILE: directory,
  ACE_HOME: directory,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
});
const runtime: Pick<GitProcessRuntime, "spawn"> = {
  spawn: (command, args, options) =>
    spawnGitProcess(command, args, { ...options, env: { ...options.env, ...environment } }),
};
const retained = new GitService({ processRuntime: runtime });
const latency = new GitService({ processRuntime: runtime, checkpointCounterCacheSize: 1 });
const sample = async () => {
  global.gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  global.gc?.();
  return { ...process.memoryUsage(), counters: retained.resourceUsage().checkpointCounters };
};
const allocate = (service: GitService, threadId: string, label: string) =>
  service.createCheckpoint({ worktree: repo, threadId, label });
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
async function timing(history: number) {
  const warm: number[] = [];
  const evicted: number[] = [];
  for (let index = 0; index < 10; index++) {
    let start = performance.now();
    await allocate(latency, "history", `warm ${history} ${index}`);
    warm.push(performance.now() - start);
    await allocate(latency, "evictor", `evict ${history} ${index}`);
    start = performance.now();
    await allocate(latency, "history", `cold ${history} ${index}`);
    evicted.push(performance.now() - start);
  }
  return {
    historyBeforeSamples: history,
    samples: 10,
    warmMeanMs: mean(warm),
    evictedMeanMs: mean(evicted),
  };
}
try {
  await execute("git", ["init", "-b", "main", repo], { env: environment, timeout: 120_000 });
  await retained.init(repo);
  const memory = [];
  for (let index = 0; index < count; index++) {
    await allocate(retained, `thread_${index}`, "retention");
    if (index === 127 || index === count - 1)
      memory.push({ distinctThreads: index + 1, memory: await sample() });
  }
  for (let index = 0; index < 10; index++) await allocate(latency, "history", `seed ${index}`);
  const early = await timing(10);
  for (let index = 30; index < 100; index++) await allocate(latency, "history", `seed ${index}`);
  const late = await timing(100);
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        loadAtStart,
        loadAtEnd: loadavg(),
        memory,
        allocation: [early, late],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await retained.close();
  await latency.close();
  await rm(directory, { recursive: true, force: true });
}
