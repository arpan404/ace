import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { fileChanges, type Turn } from "@ace/ui-core";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { daemonCheckout, type CheckoutSource } from "./checkout-source.ts";

const sources = new WeakMap<ClientApi, CheckoutSource>();

/** The checkout source for this app's client, made once. */
export function useCheckoutSource(): CheckoutSource {
  const client = useClient();
  let source = sources.get(client);
  if (!source) {
    source = daemonCheckout(client);
    sources.set(client, source);
  }
  return source;
}

/** Every path the thread's agents changed, newest change first, each once. */
export function editedPaths(turns: readonly Turn[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let t = turns.length - 1; t >= 0; t--)
    for (const edit of (turns[t]?.edits ?? []).toReversed())
      for (const change of fileChanges(edit).toReversed()) {
        const path = change.movePath ?? change.path;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push(path);
      }
  return out;
}

/** How many of the thread's edits touched `path`: a new one means the file changed on disk. */
function touches(turns: readonly Turn[], path: string): number {
  let count = 0;
  for (const turn of turns)
    for (const edit of turn.edits)
      for (const change of fileChanges(edit))
        if (change.path === path || change.movePath === path) count++;
  return count;
}

export function useEditedPaths(threadId: string): string[] {
  const turns = useTurns(threadId);
  return useMemo(() => editedPaths(turns), [turns]);
}

/**
 * A checkout file to show, read again when an agent edits it (the thread's turns gain an edit
 * of the path) and after a reconnect. Undefined `path` reads nothing.
 */
export function useFileContent(threadId: string, path: string | undefined) {
  const source = useCheckoutSource();
  const turns = useTurns(threadId);
  const edits = useMemo(() => (path ? touches(turns, path) : 0), [turns, path]);
  return useDaemonQuery({
    queryKey: ["checkout", "file", threadId, path, edits],
    enabled: path !== undefined,
    // Files can be large; keep only the ones on screen and a few recent ones.
    gcTime: 60_000,
    retry: false,
    read: (_client, signal) => source.read(threadId, path ?? "", signal),
  });
}

/** `value`, once it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Paths in the checkout matching `query` (the daemon's path index), searched once typing
 * pauses. `pending` is true from the first keystroke until the results for it arrive.
 */
export function useCheckoutSearch(threadId: string, query: string) {
  const source = useCheckoutSource();
  const trimmed = query.trim();
  const settled = useSettled(trimmed, 120);
  const result = useDaemonQuery({
    queryKey: ["checkout", "search", threadId, settled],
    enabled: settled.length > 0,
    staleTime: 10_000,
    retry: false,
    placeholderData: keepPreviousData,
    read: (_client, signal) => source.search(threadId, settled, signal),
  });
  const pending = trimmed.length > 0 && (trimmed !== settled || result.isFetching);
  return { ...result, pending, settledQuery: settled };
}
