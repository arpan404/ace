import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * A daemon process's OS threads by owner. Bun's runtime names its own threads (its pool, GC
 * helpers and collectors, JIT helpers, the allocator's scavenger) and every JS worker thread
 * ("Worker"); their counts grow with the machine's cores and with load, so the gate budgets
 * only the workers and the daemon's own threads, whatever the host.
 */
export interface ThreadCensus {
  total: number;
  /** Bun's own: present in any Bun process, sized by the machine. */
  runtime: number;
  /** One per JS worker thread. */
  workers: number;
  /** Everything else: the main thread and native threads the daemon's code started. */
  own: number;
}

/** Bun's runtime threads, by name. Linux keeps 15 characters of a name, so only prefixes. */
const runtimeNames = [
  /^Bun Pool/,
  /^Heap Helper/,
  /^JIT Worklist/,
  /^JSC /,
  /^JSCWarmUp/,
  /^mi-scavenger/,
];

export function classifyThreads(names: readonly string[]): ThreadCensus {
  let runtime = 0;
  let workers = 0;
  for (const name of names) {
    if (name === "Worker") workers++;
    else if (runtimeNames.some((pattern) => pattern.test(name))) runtime++;
  }
  return { total: names.length, runtime, workers, own: names.length - runtime - workers };
}

/**
 * Thread names from macOS `sample` output: one `Thread_<id>` heading per thread, its name after
 * a colon (the main thread names its dispatch queue instead; an unnamed thread has none).
 */
export function sampledThreadNames(report: string): string[] {
  const names: string[] = [];
  for (const line of report.split("\n")) {
    const heading = /^ +\d+ Thread_\d+(.*)$/.exec(line);
    if (!heading) continue;
    const rest = heading[1] ?? "";
    names.push(rest.startsWith(": ") ? rest.slice(2).trim() : rest.trim());
  }
  return names;
}

const run = promisify(execFile);

/** The names of a running process's threads: `/proc` on Linux, `sample` on macOS. */
export async function threadNames(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    const tasks = await readdir(`/proc/${pid}/task`);
    return Promise.all(
      tasks.map(async (task) => (await readFile(`/proc/${pid}/task/${task}/comm`, "utf8")).trim()),
    );
  }
  if (process.platform !== "darwin")
    throw new Error(`Thread names are not measured on ${process.platform}`);
  const directory = await mkdtemp(join(tmpdir(), "ace-thread-sample-"));
  try {
    const file = join(directory, "sample.txt");
    // One second of samples is enough to list every thread; symbolication takes the rest.
    await run("/usr/bin/sample", [String(pid), "1", "-mayDie", "-file", file], {
      timeout: 60_000,
    });
    return sampledThreadNames(await readFile(file, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function threadCensus(pid: number): Promise<ThreadCensus> {
  return classifyThreads(await threadNames(pid));
}
