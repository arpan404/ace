import { isMainThread } from "node:worker_threads";

/** Process-test instrumentation: RSS includes every daemon worker, unlike per-isolate heap size. */
// Workers inherit --import; only the daemon's main thread owns its process IPC channel.
if (isMainThread) {
  process.channel?.unref();
  const timer = setInterval(() => {
    process.send?.({ type: "rss", bytes: process.memoryUsage.rss() });
  }, 50);
  timer.unref();
}
