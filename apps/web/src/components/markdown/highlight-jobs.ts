import { offThread } from "@/lib/off-thread.ts";
import { WorkQueue } from "@/lib/work-queue.ts";
import { codeLines, type CodeLines } from "./code-lines.ts";
import { CodeLinesReply } from "./code-lines-wire.ts";
type Input = { code: string; lang: string | undefined; hash: string };
const worker = offThread<Input, CodeLines>({
  spawn: () =>
    new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-highlight",
    }),
  local: (input) => codeLines(input.code, input.lang, input.hash),
  decode: (output) => CodeLinesReply.parse(output),
});
/** Separate from prose, one active source and at most 16 MiB of retained source inputs. */
export const highlightJobs = new WorkQueue((input: Input, signal) => worker.run(input, signal), {
  jobs: 32,
  bytes: 16 * 1024 * 1024,
});
