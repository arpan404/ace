import { WorkQueue } from "@/lib/work-queue.ts";
import { runMarkitHighlight } from "./markit-highlight.ts";
import type { CodeLines } from "./code-lines.ts";

type Input = { code: string; lang: string | undefined; hash: string };

/** Separate from prose, one active source and at most 16 MiB of retained source inputs. */
export const highlightJobs = new WorkQueue<Input, CodeLines | undefined>(
  (input, signal) => runMarkitHighlight(input, signal),
  {
    jobs: 32,
    bytes: 16 * 1024 * 1024,
  },
);
