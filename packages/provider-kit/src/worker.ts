import { channel } from "node:diagnostics_channel";
import { delimiter } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";

/**
 * Where a benchmark names its measurement preloads (paths joined with the path delimiter) for
 * every worker thread ace starts. Unset outside benchmarks.
 */
export const workerPreloadVariable = "ACE_BENCH_WORKER_PRELOAD";

/** Node publishes every new worker here; Bun publishes nothing, so its observers hear it from us. */
const created = channel("worker_threads");

/**
 * Starts a worker thread. Every worker ace runs starts here, so a benchmark can observe them all:
 * on Node a preload passed with `--import` reaches workers by itself, but Bun gives a worker no
 * preload unless its options name one, and announces no new worker. With the benchmark's
 * variable set, the worker gets those preloads and is announced on the `worker_threads` channel
 * as Node announces it.
 */
export function startWorker(
  url: URL | string,
  options: WorkerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Worker {
  const preload = env[workerPreloadVariable]?.split(delimiter).filter(Boolean) ?? [];
  const bun = process.versions.bun !== undefined;
  if (!bun || preload.length === 0) return new Worker(url, options);
  // Bun's own WorkerOptions add `preload`; Node's types don't know it.
  const measured: WorkerOptions & { preload: string[] } = { ...options, preload };
  const worker = new Worker(url, measured);
  created.publish({ worker });
  return worker;
}
