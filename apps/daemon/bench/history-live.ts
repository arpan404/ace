import { performance } from "node:perf_hooks";
import { reviewFixture } from "../src/history-review-support.ts";

// Non-gating; execute at merge only. All provider behaviour is synthetic.
const f = await reviewFixture();
try {
  const resumed = await f.continueThread("resume");
  if (resumed.type !== "history.continue" || resumed.status !== "continued")
    throw new Error("Missing live session");
  let delivered: Promise<void> | undefined;
  const stop = f.store.subscribe((events) => {
    if (
      !events.some(
        (event) =>
          event.payload.type === "thread.created" && event.payload.thread.title === "other",
      )
    )
      return;
    delivered = (async () => {
      for (let i = 0; i < 2000; i++) await f.emit("A", `frame-${i}`);
      await f.exit("A");
    })();
    void delivered.catch(() => undefined);
  });
  try {
    const start = performance.now();
    const result = await f.importRequest(f.client, "other");
    if (result.type !== "history.import" || result.status !== "imported" || !delivered)
      throw new Error("Missing overlap publication");
    await delivered;
    const ms = performance.now() - start;
    console.log(
      JSON.stringify({
        benchmark: "publication-backpressure-and-2000-live-frames",
        ms,
        framesPerSecond: 2000 / (ms / 1000),
        microsecondsPerFrame: (ms * 1000) / 2000,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  } finally {
    stop();
  }
} finally {
  await f.close();
}
