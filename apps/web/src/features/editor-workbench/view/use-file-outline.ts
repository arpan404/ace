import type { OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { useEffect, useSyncExternalStore } from "react";
import { outlinePort, type OutlinePort, type TextBuffer } from "../buffers/index.ts";

/** Wait this long after an edit before asking the worker for fresh symbols. */
export const outlineDebounceMs = 300;
const maxCacheEntries = 32;

interface CacheEntry {
  key: string;
  symbols: readonly OutlineSymbol[];
}

const emptySymbols: readonly OutlineSymbol[] = [];

/**
 * Shared LRU cache of parsed outlines, keyed by buffer identity + document contentId + language.
 * Breadcrumbs, Outline, and Go to symbol read from the same cache so a file is parsed once per
 * settled edit, never once per consumer.
 */
const cache = new Map<TextBuffer, CacheEntry>();
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

export interface FileOutlineState {
  symbols: readonly OutlineSymbol[];
  loading: boolean;
}

/**
 * Computes and caches document symbols for `buffer` off the main thread in the editor worker.
 * Runs immediately when a file opens or switches, and waits for a typing pause (`debounceMs`)
 * after edits so big files never re-parse per keystroke.
 */
export function useFileOutline(
  buffer: TextBuffer | undefined,
  languageOrPath: string | undefined,
  options?: { port?: OutlinePort; debounceMs?: number },
): FileOutlineState {
  const debounceMs = options?.debounceMs ?? outlineDebounceMs;
  const port = options?.port ?? outlinePort();

  // Track buffer readiness & contentId changes without reading full text on every keystroke.
  const stamp = useSyncExternalStore(
    (changed) => (buffer ? buffer.subscribe(changed) : () => {}),
    () => {
      if (!buffer) return undefined;
      const doc = buffer.document();
      if (!doc) return undefined;
      return `${buffer.key.root}:${buffer.key.path}:${doc.contentId()}:${languageOrPath ?? ""}`;
    },
  );

  const cached = useSyncExternalStore(subscribeCache, () =>
    buffer ? cache.get(buffer) : undefined,
  );

  useEffect(() => {
    if (!buffer || !stamp) return;
    const existing = cache.get(buffer);
    if (existing?.key === stamp) return;

    let cancelled = false;
    // First parse for a newly opened file runs right away; edits wait for a typing pause.
    const delay = existing ? debounceMs : 0;

    const run = () => {
      const doc = buffer.document();
      if (cancelled || !doc) return;
      const liveStamp = `${buffer.key.root}:${buffer.key.path}:${doc.contentId()}:${languageOrPath ?? ""}`;
      if (liveStamp !== stamp) return;
      const text = doc.text();
      void port.extract(text, languageOrPath).then(
        (symbols) => {
          if (cancelled) return;
          setCached(buffer, stamp, symbols);
        },
        () => {
          // On unexpected failure, keep last known symbols rather than clearing the Outline.
        },
      );
    };

    if (delay === 0) {
      run();
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(run, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [buffer, stamp, languageOrPath, port, debounceMs]);

  if (!buffer || !stamp) return { symbols: emptySymbols, loading: false };
  return {
    symbols: cached?.symbols ?? emptySymbols,
    loading: cached?.key !== stamp,
  };
}
