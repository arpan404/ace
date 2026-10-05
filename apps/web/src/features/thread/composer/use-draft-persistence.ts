import type { ComposerDraft, KeyValueStorage } from "@ace/ui-core";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { draftsKey, readDraft, writeDraft, writeDraftJson } from "./draft-store.ts";

/** How long typing may pause before the draft is written; a leave or reload writes at once. */
const settleMs = 300;

/**
 * Keep the composer's unsent draft under `key` on this device: written once typing settles, and
 * at once when the composer goes away or the page is hidden (`visibilitychange`, `pagehide`), so
 * navigating, switching apps or reloading never loses it. An empty draft removes the key;
 * `discard()` removes it at once, for a message just sent. When another window writes the same
 * key, `onExternal` gets that draft (UX audit SY-12); drafts stay per device.
 */
export function useDraftPersistence(
  key: string | undefined,
  draft: ComposerDraft,
  onExternal?: (draft: ComposerDraft | undefined) => void,
): { discard(): void } {
  const { storage } = useLayout();
  const pending = useRef<string | undefined>(undefined);
  const serial = JSON.stringify(draft);
  useEffect(() => {
    if (!key) return;
    const flush = () => flushDraft(pending, storage, key);
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, [key, storage]);
  useEffect(() => {
    if (!key) return;
    pending.current = serial;
    const timer = setTimeout(() => flushDraft(pending, storage, key), settleMs);
    return () => clearTimeout(timer);
  }, [key, serial, storage]);
  // Another window changed this draft: the browser says so with a `storage` event.
  const external = useEffectEvent((event: StorageEvent) => {
    if (!key || event.key !== draftsKey) return;
    const theirs = readDraft(storage, key);
    if (JSON.stringify(theirs ?? empty) === serial) return;
    onExternal?.(theirs);
  });
  useEffect(() => {
    if (!key) return;
    const listen = (event: StorageEvent) => external(event);
    addEventListener("storage", listen);
    return () => removeEventListener("storage", listen);
  }, [key]);
  return {
    discard() {
      pending.current = undefined;
      if (key) writeDraft(storage, key, undefined);
    },
  };
}

const empty: ComposerDraft = { text: "", mentions: [], attachments: [] };

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
