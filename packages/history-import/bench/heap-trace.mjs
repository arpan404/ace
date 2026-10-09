// Measurement-only preload; never records transcript content or process environment.
import { isMainThread } from "node:worker_threads";
import { appendFileSync } from "node:fs";
const target = process.env.ACE_HISTORY_HEAP_TRACE;
if (!isMainThread && target) {
  const sample = () => appendFileSync(target, JSON.stringify(process.memoryUsage()) + "\n");
  sample();
  setInterval(sample, 100).unref();
}
