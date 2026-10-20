import type { ComposerDraft, KeyValueStorage } from "@ace/ui-core";
import { useEffect, useEffectEvent, useState, type RefObject } from "react";
import type { useAttachments } from "./attachments.tsx";
import { draftSaveFailed, writeDraft } from "./draft-store.ts";
import { mergeReturnedDraft } from "./returned-draft.ts";
import { takeDraftsFor, type ReturnedDraft } from "./send-store.ts";
import { useDraftPersistence } from "./use-draft-persistence.ts";

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };

/** A list of files by what they are, to compare two drafts' files. */
const shas = (list: readonly { sha256: string }[]) => list.map((file) => file.sha256).join();

/**
 * Keep the draft on this device and in step with other windows (SY-12): another window's
 * version is taken whole by an idle composer and offered (`theirs`) to a focused one. Files
 * can't be set in place, so a different set remounts the composer on that draft. Edit on a
 * failed message joins its text to what's here and brings its files back.
 */
export function useDraftSync(args: {
  draftKey: string | undefined;
  storage: KeyValueStorage | undefined;
  current: ComposerDraft;
  input: RefObject<HTMLDivElement | null>;
  attachments: ReturnType<typeof useAttachments>;
  keepsAttachments: boolean;
  /** Take a draft's text in place. */
  take(draft: ComposerDraft): void;
  /** Remount on a draft whose files differ. */
  replace(draft: ComposerDraft): void;
  /** Take another window's browser annotations along with its words. */
  takeAnnotations(annotations: ComposerDraft["annotations"]): void;
  onDraftChange?: ((draft: ComposerDraft) => void) | undefined;
  ownsDraft?: (() => boolean) | undefined;
  onReturnedOptions?: ((options: ReturnedDraft["options"]) => void) | undefined;
}) {
  "use no memo";
  const { draftKey, storage, current, attachments } = args;
  const [theirs, setTheirs] = useState<ComposerDraft>();
  const otherFiles = (next: ComposerDraft) =>
    args.keepsAttachments && shas(next.attachments) !== shas(attachments.ready);
  const take = (next: ComposerDraft) => {
    setTheirs(undefined);
    args.take(next);
  };
  const saved = useDraftPersistence(
    draftKey,
    current,
    (next) => {
      const draft = next ?? emptyDraft;
      if (
        document.activeElement === args.input.current ||
        (draftKey && draftSaveFailed(storage, draftKey))
      )
        return void setTheirs(draft);
      args.takeAnnotations(draft.annotations);
      if (!otherFiles(draft)) return void take(draft);
      args.replace(draft);
      return "replace";
    },
    args.onDraftChange,
    args.ownsDraft,
  );
  const takeReturned = useEffectEvent((returned: ReturnedDraft) => {
    if (!draftKey) return false;
    const next = mergeReturnedDraft({ ...current, attachments: attachments.ready }, returned);
    saved.drop();
    const written = writeDraft(storage, draftKey, next);
    args.onReturnedOptions?.(returned.options);
    args.replace(next);
    return written;
  });
  const saveReturned = useEffectEvent(() =>
    draftKey
      ? writeDraft(storage, draftKey, { ...current, attachments: attachments.ready })
      : false,
  );
  /**
   * Show exactly `next`. In place when its files are the ones attached now, so the strip above
   * (the queue, with the pages it loaded) stays as it is; a remount only for other files.
   */
  const replaceWhole = useEffectEvent((next: ComposerDraft) => {
    if (!draftKey) return false;
    const written = writeDraft(storage, draftKey, next);
    args.takeAnnotations(next.annotations);
    if (!otherFiles(next)) take(next);
    else {
      saved.drop();
      args.replace(next);
    }
    return written;
  });
  useEffect(() => {
    if (!draftKey) return;
    return takeDraftsFor(
      draftKey,
      (returned) => takeReturned(returned),
      () => saveReturned(),
      (next) => replaceWhole(next),
    );
  }, [draftKey]);
  return {
    saved,
    theirs,
    /** Take a draft's text in place, clearing any offer from another window. */
    take,
    /** Use another window's version: in place, or by remounting when its files differ. */
    apply: (next: ComposerDraft) => {
      if (!otherFiles(next)) return take(next);
      saved.drop();
      args.replace(next);
    },
  };
}
