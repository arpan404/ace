import { extractSymbols, type OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { offThread } from "@/lib/off-thread.ts";
import type { MergeJob, OutlineReply } from "./merge-job.ts";

export interface OutlinePort {
  extract(text: string, language: string | undefined): Promise<readonly OutlineSymbol[]>;
}

/*
 * The reply comes from ace's own worker running `extractSymbols`, so it is not validated again
 * (ADR 0125): a schema walk of a 20,000-line file's symbols cost 4-22 ms on the main thread.
 */
function isOutlineReply(output: unknown): output is OutlineReply {
  return (
    typeof output === "object" &&
    output !== null &&
    "op" in output &&
    output.op === "outline" &&
    "symbols" in output &&
    Array.isArray(output.symbols)
  );
}

let sharedPort: OutlinePort | undefined;

/**
 * Runs symbol extraction in the editor's existing background worker (`merge.worker.ts`) so
 * scanning large files stays off the main thread. Falls back to in-place extraction where
 * `Worker` is unavailable (jsdom tests).
 */
export function outlinePort(): OutlinePort {
  if (sharedPort) return sharedPort;
  const worker = offThread<MergeJob, OutlineReply>({
    spawn: () =>
      new Worker(new URL("./merge.worker.ts", import.meta.url), {
        type: "module",
        name: "editor-outline",
      }),
    local: async (job) => {
      if (job.op !== "outline") throw new Error("Unexpected job on outline port.");
      return { op: "outline", symbols: extractSymbols(job.text, job.language) };
    },
    decode: (output) => {
      if (!isOutlineReply(output)) throw new Error("The editor worker answered the wrong job.");
      return output;
    },
  });
  sharedPort = {
    async extract(text, language) {
      const reply = await worker.run({ op: "outline", text, language });
      return reply.symbols;
    },
  };
  return sharedPort;
}
