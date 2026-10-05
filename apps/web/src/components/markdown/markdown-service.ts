import { prefersReducedMotion } from "@/lib/motion.ts";
import { updateInterval } from "./cadence.ts";
import { MarkdownStore } from "./markdown-store.ts";
import type { StreamReply } from "./stream-registry.ts";
import { localStreams, markdownWorker } from "./worker.ts";

/** Updates `tools/web-perf` collects in `--mode perf` (`acePerf.markdown`); absent otherwise. */
const perf: unknown = Reflect.get(globalThis, "acePerf");
const samples =
  typeof perf === "object" && perf !== null && "markdown" in perf && Array.isArray(perf.markdown)
    ? perf.markdown
    : undefined;

/** The page's markdown documents, built in the markdown worker. */
export const markdownService = new MarkdownStore({
  backend: {
    parallel: markdownWorker.parallel,
    run: (job) =>
      markdownWorker.run(job).then((reply): StreamReply => {
        if (reply && ("resync" in reply || "from" in reply)) return reply;
        throw new Error("The markdown worker answered a stream job with something else");
      }),
    local: (job) => localStreams.apply(job),
    release(stream) {
      if (markdownWorker.parallel) void markdownWorker.run({ release: stream }).catch(() => {});
      else localStreams.release(stream);
    },
  },
  now: () => performance.now(),
  schedule(delayMs, run) {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  interval: (lastMs) => updateInterval(lastMs, prefersReducedMotion()),
  ...(samples ? { updated: (update) => void samples.push(update) } : {}),
});
