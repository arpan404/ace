import { markitWorkerPath } from "@ace/markit-web";
import { MarkitRenderer, type HighlightedCode } from "@ace/markit-web/react";
import { offThread } from "@/lib/off-thread.ts";
import { codeLines, overResultLimit, splitLines, type CodeLines } from "./code-lines.ts";
import { CodeLinesReply } from "./code-lines-wire.ts";

/*
 * Syntax colors from markit's Rust tokenizer (its Wasm worker), the same engine that paints
 * prose fences. Markit answers plain past its run budget (large files) and for languages it
 * does not know; the previous engine colors those in its own worker, never on the main thread.
 * Where the platform has no Worker (tests, very old engines) the previous engine runs in place.
 */

/** One renderer for the page; highlighting is stateless, so streams are never involved. */
let renderer: MarkitRenderer | undefined;
function shared(): MarkitRenderer {
  renderer ??= new MarkitRenderer(document.createElement("div"), {
    workerURL: markitWorkerPath(),
  });
  return renderer;
}

type Input = { code: string; lang: string | undefined; hash: string };

const fallback = offThread<Input, CodeLines>({
  spawn: () =>
    new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-highlight",
    }),
  local: (input) => codeLines(input.code, input.lang, input.hash),
  decode: (output) => CodeLinesReply.parse(output),
});

/** Markit highlight tokens as ace code lines, keeping both theme colors. */
export function markitCodeLines(result: HighlightedCode, hash: string): CodeLines {
  if (result.plain) return { hash, plain: true };
  const doc: CodeLines = {
    hash,
    lines: splitLines(result.tokens.map((token) => ({ kind: "plain" as const, ...token }))),
  };
  return overResultLimit(doc) ? { hash, plain: true } : doc;
}

/** Settles with `work`, or rejects as soon as `signal` aborts; the listener never outlives it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Markit highlight cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Highlighted lines for exactly this source, or undefined when nobody needs them anymore. */
export async function runMarkitHighlight(
  input: Input,
  signal: AbortSignal,
): Promise<CodeLines | undefined> {
  if (signal.aborted) return undefined;
  if (typeof Worker === "function") {
    try {
      const highlighted = await untilAborted(
        shared().highlight(input.code, input.lang ?? "", { grammar: false }),
        signal,
      );
      const doc = markitCodeLines(highlighted, input.hash);
      if (!("plain" in doc)) return doc;
    } catch {
      if (signal.aborted) return undefined;
    }
  }
  try {
    return await fallback.run(input, signal);
  } catch {
    return undefined;
  }
}
