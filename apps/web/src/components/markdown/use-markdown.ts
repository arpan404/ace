import { contentHash } from "@ace/ui-core";
import { useCallback, useEffect, useId, useMemo, useSyncExternalStore } from "react";
import type { MarkdownDoc } from "./blocks.ts";
import { markdownService } from "./markdown-service.ts";

/**
 * The rendered blocks of `text`, lexed and highlighted off the main thread. Undefined until the
 * first document for this message is ready; while newer text is being prepared the previous
 * document stays on screen.
 */
export function useMarkdown(text: string): MarkdownDoc | undefined {
  const slot = useId();
  const hash = useMemo(() => contentHash(text), [text]);
  const subscribe = useCallback(
    (changed: () => void) => markdownService.watch(slot, changed),
    [slot],
  );
  const read = useCallback(() => markdownService.read(slot, text, hash), [slot, text, hash]);
  const doc = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (doc?.hash !== hash) markdownService.want(slot, text);
  }, [slot, text, hash, doc?.hash]);
  return doc;
}
