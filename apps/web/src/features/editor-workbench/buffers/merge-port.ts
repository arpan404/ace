import { offThread } from "@/lib/off-thread.ts";
import { MergeReply, runMergeJob, type MergeJob } from "./merge-job.ts";
import type { MergePort } from "./types.ts";

/** Below this many UTF-16 units in total a merge runs in place: a worker round trip costs more. */
export const inPlaceBelow = 256 * 1024;

/**
 * The registry's merge, in a worker for large texts so a 200,000-line file never blocks typing
 * (ADR 0056: heavy derived work stays off the main thread). `ready` loads the page's Wasm for the
 * in-place path.
 */
export function workerMerge(ready: () => Promise<void>): MergePort {
  const worker = offThread<MergeJob, MergeReply>({
    spawn: () =>
      new Worker(new URL("./merge.worker.ts", import.meta.url), {
        type: "module",
        name: "editor-merge",
      }),
    local: async (job) => {
      await ready();
      return runMergeJob(job);
    },
    decode: (output) => MergeReply.parse(output),
  });
  const run = async (job: MergeJob, size: number) => {
    if (size < inPlaceBelow) {
      await ready();
      return runMergeJob(job);
    }
    return worker.run(job);
  };
  return {
    async merge3(base, mine, theirs) {
      const reply = await run(
        { op: "merge3", base, mine, theirs },
        base.length + mine.length + theirs.length,
      );
      if (Array.isArray(reply)) throw new Error("The merge worker answered the wrong job.");
      return reply;
    },
    async lineChanges(before, after) {
      const reply = await run({ op: "lineChanges", before, after }, before.length + after.length);
      if (!Array.isArray(reply)) throw new Error("The merge worker answered the wrong job.");
      return reply;
    },
  };
}
