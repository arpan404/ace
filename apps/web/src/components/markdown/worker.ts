import { offThread } from "@/lib/off-thread.ts";
import { markdownDoc, type MarkdownDoc } from "./blocks.ts";
import { codeLines, type CodeLines } from "./code-lines.ts";

/** A job for the markdown worker: a message's markdown, or a whole source file's lines. */
export type MarkdownJob =
  | { text: string; hash: string }
  | { code: string; lang?: string | undefined; hash: string };

/** One markdown worker for transcript prose and file viewers alike. */
export const markdownWorker = offThread<MarkdownJob, MarkdownDoc | CodeLines>({
  spawn: () =>
    new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-markdown",
    }),
  local: (job) =>
    "code" in job ? codeLines(job.code, job.lang, job.hash) : markdownDoc(job.text, job.hash),
  // Same-origin worker built from blocks.ts and code-lines.ts; its output is not decoded twice.
  decode: (output) => output as MarkdownDoc | CodeLines,
});
