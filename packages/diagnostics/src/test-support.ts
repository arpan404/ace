import { Worker } from "node:worker_threads";
import { probeOutput } from "@ace/provider-kit/process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { sqliteSizes, type HealthRuntime, type LogWorkerRuntime } from "./index.ts";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ace-diag-test-"));
  roots.push(root);
  return root;
}
const noop = () => {};
export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  let reject: (error: Error) => void = noop;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Real measurements; tests advance deadlines separately instead of budgeting machine speed. */
export const measuredHealth: HealthRuntime = {
  createDelay: () => monitorEventLoopDelay({ resolution: 20 }),
  memory: process.memoryUsage,
  resources: process.getActiveResourcesInfo,
  sqlite: (path, signal) => sqliteSizes(path, signal, controlledSqlite),
  schedule: () => noop,
  deadlineMs: 1000,
};

export async function unpack(path: string) {
  const entries = new Map<string, string>();
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    let text = "";
    stream.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected bytes");
      text += chunk.toString();
    });
    stream.on("end", () => {
      entries.set(header.name, text);
      next();
    });
    stream.on("error", (error) => extract.destroy(error));
  });
  await pipeline(createReadStream(path), createGunzip(), extract);
  return entries;
}

export const controlledProbe: typeof probeOutput = (command, args, options) =>
  probeOutput(command, args, { ...options, schedule: () => noop });
export const systemProbeRuntime = {
  probe: controlledProbe,
  async statfs(directory: string) {
    await statfs(directory);
    return { bavail: 2 * 1024 * 1024 * 1024, bsize: 1 };
  },
};

export const controlledSqlite = { probe: controlledProbe, deadlineMs: 5000 };
export const controlledWorker: LogWorkerRuntime = {
  spawn: (url, data) => new Worker(url, { workerData: data }),
  schedule: () => noop,
  deadlineMs: 5000,
};
