import { markitWorkerPath } from "@ace/markit-web";
import { MarkitRenderer, type HighlightedCode } from "@ace/markit-web/react";
import { codeLines, overResultLimit, splitLines, type CodeLines } from "./code-lines.ts";

/*
 * Syntax colors from markit's Rust tokenizer (its Wasm worker), the same engine that paints
 * prose fences and the file viewer. Where the platform has no Worker (tests, very old
 * engines) the previous local highlighter runs instead, so callers see one asynchronous
 * interface either way. A markit failure also falls back to it, so text stays readable.
 */

/** One renderer for the page; highlighting is stateless, so streams are never involved. */
let renderer: MarkitRenderer | undefined;
function shared(): MarkitRenderer {
  renderer ??= new MarkitRenderer(document.createElement("div"), {
    workerURL: markitWorkerPath(),
  });
  return renderer;
}

/** Markit highlight tokens as ace code lines, keeping both theme colors. */
export function markitCodeLines(result: HighlightedCode, hash: string): CodeLines {
  if (result.plain) return { hash, plain: true };
  const doc: CodeLines = {
    hash,
    lines: splitLines(result.tokens.map((token) => ({ kind: "plain" as const, ...token }))),
  };
  return overResultLimit(doc) ? { hash, plain: true } : doc;
}

const cancelled = () => new DOMException("Markit highlight cancelled", "AbortError");

/** Highlighted lines for exactly this source, or undefined when nobody needs them anymore. */
export async function runMarkitHighlight(
  input: { code: string; lang: string | undefined; hash: string },
  signal: AbortSignal,
): Promise<CodeLines | undefined> {
  if (signal.aborted) return undefined;
  if (typeof Worker === "function") {
    try {
      const highlighted = await Promise.race([
        shared().highlight(input.code, input.lang ?? "", { grammar: false }),
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(cancelled()), { once: true }),
        ),
      ]);
      if (signal.aborted) return undefined;
      const doc = markitCodeLines(highlighted, input.hash);
      // Markit bails to plain past its run budget (large files): the previous engine keeps
      // those colored, and covers unknown languages with its regex tones.
      if (!("plain" in doc)) return doc;
    } catch {
      if (signal.aborted) return undefined;
    }
  }
  return codeLines(input.code, input.lang, input.hash);
}
