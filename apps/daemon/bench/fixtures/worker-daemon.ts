import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { startWorker } from "@ace/provider-kit/worker";

/**
 * A stand-in daemon for the bench's own tests: it starts the workers its arguments name, then
 * writes its endpoint file as a daemon does and stops on the bench's close message.
 *   import            a worker, started by ace's factory, that imports a forbidden package
 *   clean             a worker, started by ace's factory, that imports nothing
 *   unwatched         a worker started past ace's factory, which no measurement preload reaches
 *   retired           a clean worker that has exited before the daemon is ready
 *   unwatched-retired an unwatched worker that has exited before the daemon is ready
 * Workers start one after another, in the order named.
 */
const kinds = process.argv.slice(2);
const workers: Worker[] = [];
for (const kind of kinds) {
  const url = new URL(kind === "import" ? "./worker-import.ts" : "./worker-idle.ts", import.meta.url);
  const worker = kind.startsWith("unwatched") ? new Worker(url) : startWorker(url);
  await new Promise((resolve) => worker.once("message", resolve));
  if (kind.endsWith("retired")) await worker.terminate();
  else workers.push(worker);
}
const home = process.env.ACE_HOME;
if (home) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "daemon-endpoint"), "http://127.0.0.1:1\n");
}
process.send?.({ id: 0, ready: true });
process.on("message", () => {
  void Promise.all(workers.map((worker) => worker.terminate())).then(() => process.exit(0));
});
