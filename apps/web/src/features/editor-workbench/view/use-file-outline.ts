import type { OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { useEffect, useSyncExternalStore } from "react";
import { outlinePort, type OutlinePort, type TextBuffer } from "../buffers/index.ts";
import { onBufferEdits } from "./buffer-edits.ts";

/** Wait this long after an edit before asking the worker for fresh symbols. */
export const outlineDebounceMs = 300;
const maxCacheEntries = 32;

interface CacheEntry {
  key: string;
  symbols: readonly OutlineSymbol[];
}

const emptySymbols: readonly OutlineSymbol[] = [];

/*
 * One outline per buffer, shared by the breadcrumbs, the Outline view and Go to symbol, so a file
 * is read once per settled edit, never once per consumer. Edits are heard through
 * `onBufferEdits` (a view's own typing emits no buffer event).
 */
const cache = new Map<TextBuffer, CacheEntry>();
const pending = new Map<TextBuffer, string>();
/** Each buffer's mounted outlines, told when a read lands on text that has since changed. */
const waiting = new WeakMap<TextBuffer, Set<() => void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function setCached(buffer: TextBuffer, key: string, symbols: readonly OutlineSymbol[]): void {
  cache.delete(buffer);
  cache.set(buffer, { key, symbols });
  if (cache.size > maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  notify();
}

function stampOf(buffer: TextBuffer, language: string | undefined): string | undefined {
  const doc = buffer.document();
  if (!doc) return undefined;
  return `${doc.contentId()}\u0000${language ?? ""}`;
}

export interface FileOutlineState {
  symbols: readonly OutlineSymbol[];
}

/**
 * Document symbols for `buffer`, read off the main thread in the editor worker. The first read of
 * a file runs at once; after an edit it waits for a typing pause (`debounceMs`), so a big file is
 * never read per keystroke. A consumer re-renders only when a new outline lands.
 */
export function useFileOutline(
  buffer: TextBuffer | undefined,
  languageOrPath: string | undefined,
  options?: { port?: OutlinePort; debounceMs?: number },
): FileOutlineState {
  const debounceMs = options?.debounceMs ?? outlineDebounceMs;
  const port = options?.port ?? outlinePort();

  const cached = useSyncExternalStore(subscribeCache, () =>
    buffer ? cache.get(buffer) : undefined,
  );

  useEffect(() => {
    if (!buffer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const read = () => {
      timer = undefined;
      const doc = buffer.document();
      const stamp = stampOf(buffer, languageOrPath);
      if (disposed || !doc || !stamp) return;
      // One read at a time per buffer: edits meanwhile wait for it, then the latest is read.
      if (pending.has(buffer) || cache.get(buffer)?.key === stamp) return;
      pending.set(buffer, stamp);
      const landed = (symbols: readonly OutlineSymbol[] | undefined) => {
        pending.delete(buffer);
        if (symbols) setCached(buffer, stamp, symbols);
        if (stampOf(buffer, languageOrPath) !== stamp) {
          const heard = waiting.get(buffer);
          if (heard) for (const listener of heard) listener();
        }
      };
      void port.extract(doc.text(), languageOrPath).then(landed, () => landed(undefined));
    };

    const changed = () => {
      const stamp = stampOf(buffer, languageOrPath);
      if (!stamp || cache.get(buffer)?.key === stamp) return;
      if (timer !== undefined) clearTimeout(timer);
      // A file with no outline and no read out is read now; otherwise after the typing pause.
      if (!cache.has(buffer) && !pending.has(buffer)) read();
      else timer = setTimeout(read, debounceMs);
    };

    let heard = waiting.get(buffer);
    if (!heard) {
      heard = new Set();
      waiting.set(buffer, heard);
    }
    heard.add(changed);
    changed();
    const offBuffer = buffer.subscribe(changed);
    const offEdits = onBufferEdits(buffer, changed);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      offBuffer();
      offEdits();
      heard.delete(changed);
    };
  }, [buffer, languageOrPath, port, debounceMs]);

  return { symbols: buffer ? (cached?.symbols ?? emptySymbols) : emptySymbols };
}
