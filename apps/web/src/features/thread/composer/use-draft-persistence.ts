import type { ComposerDraft, KeyValueStorage } from "@ace/ui-core";
import { useEffect, useRef, type RefObject } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { writeDraft, writeDraftJson } from "./draft-store.ts";

/** How long typing may pause before the draft is written; a leave or reload writes at once. */
const settleMs = 300;

/**
 * Keep the composer's unsent draft under `key` on this device: written once typing settles, and
 * at once when the composer goes away or the page is hidden, so navigating or reloading never
 * loses it. An empty draft removes the key; `discard()` removes it at once, for a message the
 * daemon accepted just before the composer went away (New thread navigates on send).
 */
export function useDraftPersistence(
  key: string | undefined,
  draft: ComposerDraft,
): { discard(): void } {
  const { storage } = useLayout();
  const pending = useRef<string | undefined>(undefined);
  const serial = JSON.stringify(draft);
  useEffect(() => {
    if (!key) return;
    const flush = () => flushDraft(pending, storage, key);
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      flush();
    };
  }, [key, storage]);
  useEffect(() => {
    if (!key) return;
    pending.current = serial;
    const timer = setTimeout(() => flushDraft(pending, storage, key), settleMs);
    return () => clearTimeout(timer);
  }, [key, serial, storage]);
  return {
    discard() {
      pending.current = undefined;
      if (key) writeDraft(storage, key, undefined);
    },
  };
}

function flushDraft(
  pending: RefObject<string | undefined>,
  storage: KeyValueStorage | undefined,
  key: string,
) {
  const next = pending.current;
  if (next === undefined) return;
  pending.current = undefined;
  writeDraftJson(storage, key, next);
}
