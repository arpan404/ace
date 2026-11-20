import { init } from "@ace/editor";
import * as glue from "@ace/editor/pkg/editor_wasm.js";
import { serveOffThread } from "@/lib/off-thread.ts";
import { MergeJob, runMergeJob } from "./merge-job.ts";

// The worker loads its own copy of the editor's Wasm, once.
const ready = init({ module: glue });

serveOffThread(
  (input) => MergeJob.parse(input),
  async (job) => {
    await ready;
    return runMergeJob(job);
  },
);
