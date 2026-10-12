import { findDraft, putDraft, type ComposerDraft, type KeyValueStorage } from "@ace/ui-core";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useLayout } from "@/lib/layout.tsx";
import {
  draftsKey,
  draftSaveFailed,
  onDraftDiscard,
  readDraft,
  readDurableDraft,
  writeDraft,
  writeDraftJson,
} from "./draft-store.ts";

/** How long typing may pause before the draft is written; a leave or reload writes at once. */
const settleMs = 300;

/**
 * Keep the composer's unsent draft under `key` on this device: written once typing settles, and
 * at once when the composer goes away or the page is hidden (`visibilitychange`, `pagehide`), so
 * a successful write survives navigation and reload. Refused writes retain the latest copy in
 * this page and expose an inline warning. An empty draft removes the key;
 * `discard()` removes it at once, for a message just sent; `drop()` lets a newer stored one win. When another window writes the same
 * key, `onExternal` gets that draft (UX audit SY-12); drafts stay per device.
 */
export function useDraftPersistence(
  key: string | undefined,
  draft: ComposerDraft,
  /** Return "replace" when the composer takes the stored draft over its own unsaved copy. */
  onExternal?: (draft: ComposerDraft | undefined) => "replace" | void,
  onChange?: ((draft: ComposerDraft) => void) | undefined,
  ownsDraft?: (() => boolean) | undefined,
): { saveFailed: boolean; discard(): void; drop(): void; hold(): void; finish(): boolean } {
  const { storage } = useLayout();
  const [saveFailed, setSaveFailed] = useState(() => !!key && draftSaveFailed(storage, key));
  const pending = useRef<string | undefined>(undefined);
  const serial = JSON.stringify(draft);
  const latest = useRef(serial);
  const latestDraft = useRef(draft);
  const submitted = useRef<string | undefined>(undefined);
  const owned = useEffectEvent(() => ownsDraft?.() ?? true);
  useLayoutEffect(() => {
    latest.current = serial;
    latestDraft.current = draft;
  }, [serial, draft]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const holding = useRef(false);
  const flush = useEffectEvent((store: KeyValueStorage | undefined, draftKey: string) => {
    const saved = flushDraft(pending, store, draftKey);
    if (saved !== undefined && mounted.current) setSaveFailed(!saved);
  });
  const emptyNow = !draft.text.trim() && !draft.attachments.length;
  const notifyDraft = useEffectEvent(() => onChange?.(draft));
  useEffect(() => {
    if (!key) return;
    const stopDiscarded = onDraftDiscard((owner, discarded) => {
      if (owner !== storage || discarded !== key) return;
      pending.current = undefined;
      holding.current = false;
      setSaveFailed(false);
    });
    const save = () => flush(storage, key);
    const hidden = () => {
      if (document.visibilityState === "hidden") save();
    };
    addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stopDiscarded();
      removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", hidden);
      save();
    };
  }, [key, storage]);
  useEffect(() => {
    if (!key) return;
    notifyDraft();
    if (holding.current && emptyNow) return;
    pending.current = serial;
    const timer = setTimeout(() => flush(storage, key), settleMs);
    return () => clearTimeout(timer);
  }, [key, serial, storage, emptyNow]);
  // Another window changed this draft: the browser says so with a `storage` event.
  const external = useEffectEvent((event: StorageEvent) => {
    if (!key || event.key !== draftsKey) return;
    const theirs = readDurableDraft(storage, key);
    if (JSON.stringify(theirs ?? empty) === serial) return;
    if (onExternal?.(theirs) === "replace") pending.current = undefined;
  });
  useEffect(() => {
    if (!key) return;
    const listen = (event: StorageEvent) => external(event);
    addEventListener("storage", listen);
    return () => removeEventListener("storage", listen);
  }, [key]);
  return {
    saveFailed,
    // Keep a reload-safe copy until the outbox accepts it, even though the editor clears.
    hold() {
      holding.current = true;
      pending.current = latest.current;
      if (key) {
        flush(storage, key);
        submitted.current = version(readDraft(storage, key));
      }
    },
    finish() {
      // A reopened editor owns the durable draft now. An old submission must not flush over it.
      if (!mounted.current || !owned()) return false;
      if (key) {
        const current = version(readDraft(storage, key));
        const latestVersion = version(findDraft(putDraft([], key, latestDraft.current), key));
        if (current !== submitted.current && current !== latestVersion) return false;
      }
      holding.current = false;
      pending.current = latest.current;
      if (key) flush(storage, key);
      return true;
    },
    discard() {
      holding.current = false;
      pending.current = undefined;
      if (key) {
        const saved = writeDraft(storage, key, undefined);
        setSaveFailed(!saved);
        if (!saved) pending.current = JSON.stringify(empty);
      }
    },
    /** Forget this composer's unsaved copy without writing it: the stored draft wins. */
    drop() {
      pending.current = undefined;
    },
  };
}

const empty: ComposerDraft = { text: "", mentions: [], attachments: [] };

function flushDraft(
  pending: RefObject<string | undefined>,
  storage: KeyValueStorage | undefined,
  key: string,
): boolean | undefined {
  const next = pending.current;
  if (next === undefined) return;
  if (!writeDraftJson(storage, key, next)) return false;
  pending.current = undefined;
  return true;
}

function version(draft: ComposerDraft | undefined): string {
  return JSON.stringify([
    draft?.text ?? "",
    draft?.tokens ?? [],
    draft?.mentions ?? [],
    draft?.attachments ?? [],
  ]);
}
