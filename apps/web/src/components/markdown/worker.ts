import { offThread } from "@/lib/off-thread.ts";
import { codeLines, type CodeLines } from "./code-lines.ts";
import { StreamRegistry, type StreamJob, type StreamReply } from "./stream-registry.ts";

/** A job for the markdown worker: text appended to a message, or a whole source file's lines. */
export type MarkdownJob = StreamJob | { code: string; lang?: string | undefined; hash: string };

/** In place, where there is no worker. */
export const localStreams = new StreamRegistry(() => performance.now());

/** One markdown worker for transcript prose and file viewers alike. */
export const markdownWorker = offThread<MarkdownJob, StreamReply | CodeLines>({
  spawn: () =>
    new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-markdown",
    }),
  local: (job) =>
    "code" in job ? codeLines(job.code, job.lang, job.hash) : localStreams.apply(job),
  // Same-origin worker built from stream-registry.ts and code-lines.ts; not decoded twice.
  decode: (output) => output as StreamReply | CodeLines,
});
