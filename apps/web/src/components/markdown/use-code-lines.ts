import { LruCache } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { codeHash, codeLinesWeight, type CodeLines } from "./code-lines.ts";
import { highlightJobs } from "./highlight-jobs.ts";

/** Files highlighted this session, so switching back to a file tab shows it at once. */
const ready = new LruCache<string, CodeLines>({
  maxEntries: 12,
  maxWeight: 12 * 1024 * 1024,
  weigh: codeLinesWeight,
});

/**
 * A source file's highlighted lines, built in the highlighting worker. Undefined while they are
 * being built, when the result exceeds the token budget, or when there is no code. The caller
 * keeps its exact plain source in each case; compact plain results are cached too.
 */
export function useCodeLines(code: string | undefined, lang: string | undefined) {
  const hash = useMemo(() => (code === undefined ? undefined : codeHash(code, lang)), [code, lang]);
  const [done, setDone] = useState<CodeLines | undefined>(undefined);
  const cached = hash ? ready.get(hash) : undefined;
  useEffect(() => {
    if (code === undefined || !hash || ready.get(hash)) return;
    let live = true;
    const lease = highlightJobs.acquire(hash, { code, lang, hash }, code.length * 2);
    lease.result.then(
      (lines) => {
        // A code job answers with rich lines or a compact plain result.
        if (!lines || !live) return;
        ready.set(hash, lines);
        if (live) setDone(lines);
      },
      // Highlighting is a nicety: the plain text stays on screen.
      () => undefined,
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [code, lang, hash]);
  const result = cached ?? (done?.hash === hash ? done : undefined);
  return result && "lines" in result ? result : undefined;
}
