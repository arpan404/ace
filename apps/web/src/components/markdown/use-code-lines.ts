import { LruCache } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { codeHash, codeLinesWeight, type CodeLines } from "./code-lines.ts";
import { highlightJobs } from "./highlight-jobs.ts";

/**
 * Code highlighted this session by (language, text): a file tab switched back to, or a fence
 * scrolled back into view, shows its colours at once. Bounded by what the lines weigh; a
 * transcript's fences are small, so many fit.
 */
const ready = new LruCache<string, CodeLines>({
  maxEntries: 512,
  maxWeight: 12 * 1024 * 1024,
  weigh: codeLinesWeight,
});

/**
 * A source file's highlighted lines, built in the highlighting worker. Undefined while they are
 * being built, when the result exceeds the token budget, or when there is no code. The caller
 * keeps its exact plain source in each case; compact plain results are cached too.
 */
function useHighlightResult(code: string | undefined, lang: string | undefined) {
  const hash = useMemo(() => (code === undefined ? undefined : codeHash(code, lang)), [code, lang]);
  const cached = hash ? ready.get(hash) : undefined;
  const [done, setDone] = useState(() => ({ result: cached, latest: rich(cached) }));
  // A cache hit becomes the retained result before the caller commits its new source.
  if (cached && cached !== done.result)
    setDone({ result: cached, latest: rich(cached) ?? done.latest });
  useEffect(() => {
    if (code === undefined || !hash || ready.get(hash)) return;
    let live = true;
    const lease = highlightJobs.acquire(hash, { code, lang, hash }, code.length * 2);
    lease.result.then(
      (lines) => {
        // A code job answers with rich lines or a compact plain result.
        if (!lines || !live) return;
        ready.set(hash, lines);
        setDone((previous) => ({ result: lines, latest: rich(lines) ?? previous.latest }));
      },
      // Highlighting is a nicety: the plain text stays on screen.
      () => undefined,
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [code, lang, hash]);
  const result = cached ?? (done.result?.hash === hash ? done.result : undefined);
  return { current: rich(result), latest: rich(cached) ?? done.latest };
}

function rich(result: CodeLines | undefined) {
  return result && "lines" in result ? result : undefined;
}

/** Highlighted lines for exactly this source, undefined until they are ready. */
export function useCodeLines(code: string | undefined, lang: string | undefined) {
  return useHighlightResult(code, lang).current;
}

/**
 * Like `useCodeLines`, but while new text is being highlighted the lines built for the text
 * shown before stay: an editor keeps its colours as you type. Lines may then belong to an older
 * text, so a caller checks each line still matches before drawing its tokens (`tokensFit`).
 */
export function useLatestCodeLines(code: string | undefined, lang: string | undefined) {
  return useHighlightResult(code, lang).latest;
}
