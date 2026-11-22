import { extractSymbols, type OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { offThread } from "@/lib/off-thread.ts";
import { MergeReply, type MergeJob } from "./merge-job.ts";

export interface OutlinePort {
  extract(text: string, language: string | undefined): Promise<readonly OutlineSymbol[]>;
}

let sharedPort: OutlinePort | undefined;

/**
 * Runs symbol extraction in the editor's existing background worker (`merge.worker.ts`) so
 * scanning large files stays off the main thread. Falls back to in-place extraction where
 * `Worker` is unavailable (jsdom tests).
 */
export function outlinePort(): OutlinePort {
  if (sharedPort) return sharedPort;
  const worker = offThread<MergeJob, MergeReply>({
    spawn: () =>
      new Worker(new URL("./merge.worker.ts", import.meta.url), {
        type: "module",
        name: "editor-outline",
      }),
    local: async (job) => {
      if (job.op !== "outline") throw new Error("Unexpected job on outline port.");
      return { op: "outline", symbols: extractSymbols(job.text, job.language) };
    },
    decode: (output) => MergeReply.parse(output),
  });
  sharedPort = {
    async extract(text, language) {
      const reply = await worker.run({ op: "outline", text, language });
      if (Array.isArray(reply) || !("op" in reply)) {
        throw new Error("The editor worker answered the wrong job.");
      }
      return reply.symbols;
    },
  };
  return sharedPort;
}
