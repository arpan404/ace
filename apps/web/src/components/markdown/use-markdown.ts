import { contentHash } from "@ace/ui-core";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { MarkdownDoc } from "./blocks.ts";
import { markdownService } from "./markdown-service.ts";

/**
 * The rendered blocks of `text`, lexed and highlighted off the main thread. `stream` names text
 * that grows by appends (a message's id): only what it gained crosses to the worker, blocks
 * that settled keep their objects, and until it is `final` its updates are paced. Without a
 * stream the text itself (its hash) names one. Undefined until the first document is ready;
 * while newer text is being prepared the previous document stays on screen.
 */
export function useMarkdown(text: string, stream?: string, final = true): MarkdownDoc | undefined {
  // A streaming message is never hashed: its id names it, and its text grows every frame.
  const key = useMemo(() => stream ?? `#${contentHash(text)}`, [stream, text]);
  const subscribe = useCallback(
    (changed: () => void) => markdownService.watch(key, changed),
    [key],
  );
  const read = useCallback(() => markdownService.read(key), [key]);
  const stored = useSyncExternalStore(subscribe, read, read);
  // While the worker starts, a finished message is built here so it shows on this render; the
  // store keeps it once the view has committed.
  const cold = useMemo(
    () => (stored || !final ? undefined : markdownService.buildCold(key, text)),
    [stored, final, key, text],
  );
  useEffect(() => {
    if (cold) markdownService.adopt(key, text, cold);
    markdownService.want(key, text, final);
  }, [cold, key, text, final]);
  return stored ?? cold;
}
