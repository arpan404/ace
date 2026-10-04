import { LruCache } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { codeHash, type CodeLines } from "./code-lines.ts";
import { markdownWorker } from "./worker.ts";

/** Files highlighted this session, so switching back to a file tab shows it at once. */
const ready = new LruCache<string, CodeLines>({
  maxEntries: 12,
  maxWeight: 12 * 1024 * 1024,
  weigh: (doc) => doc.lines.reduce((sum, line) => sum + 16 + line.length * 24, 64),
});

/**
 * A source file's highlighted lines, built in the markdown worker. Undefined while they are
 * being built (show the plain text meanwhile) or when there is no code.
 */
export function useCodeLines(code: string | undefined, lang: string | undefined) {
  const hash = useMemo(() => (code === undefined ? undefined : codeHash(code, lang)), [code, lang]);
  const [done, setDone] = useState<CodeLines | undefined>(undefined);
  const cached = hash ? ready.get(hash) : undefined;
  useEffect(() => {
    if (code === undefined || !hash || ready.get(hash)) return;
    let live = true;
    markdownWorker.run({ code, lang, hash }).then(
      (output) => {
        // A code job answers with lines.
        const lines = output as CodeLines;
        ready.set(hash, lines);
        if (live) setDone(lines);
      },
      // Highlighting is a nicety: the plain text stays on screen.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, lang, hash]);
  if (cached) return cached;
  return done?.hash === hash ? done : undefined;
}
