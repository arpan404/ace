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
    // A markdown job answers with a stream reply.
    run: (job) => markdownWorker.run(job) as Promise<StreamReply>,
    local: (job) => localStreams.apply(job),
  },
  now: () => performance.now(),
  schedule(delayMs, run) {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  interval: (lastMs) => updateInterval(lastMs, prefersReducedMotion()),
  ...(samples ? { updated: (update) => void samples.push(update) } : {}),
});
