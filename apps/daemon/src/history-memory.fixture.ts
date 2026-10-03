/** Process-test instrumentation: RSS includes every daemon worker, unlike per-isolate heap size. */
const timer = setInterval(() => {
  process.send?.({ type: "rss", bytes: process.memoryUsage.rss() });
}, 50);
timer.unref();
