import { withTypedCommand, type ComposerDraft, type KeyValueStorage } from "@ace/ui-core";
import type { CatalogEntry } from "@ace/protocol";
import { useEffectEvent } from "react";
import type { useAttachments } from "./attachments.tsx";
import { withAnnotations } from "@/features/annotations/index.ts";
import type { useComposerAnnotations } from "./use-composer-annotations.ts";
import type { Draft } from "./draft.ts";
import { readDraft, writeDraft } from "./draft-store.ts";
import { mergeReturnedDraft, restoreReturnedDraft } from "./returned-draft.ts";
import type { ReturnedDraft } from "./send-store.ts";
import { composerContent } from "./submitted-draft.ts";
import type { useDraftPersistence } from "./use-draft-persistence.ts";

const fingerprint = (draft: Partial<ComposerDraft> | undefined) =>
  JSON.stringify([
    draft?.text,
    draft?.tokens ?? [],
    draft?.mentions ?? [],
    draft?.attachments ?? [],
  ]);

/**
 * Enter empties the composer at once; the message is the parent's from here on. Only a message
 * this device couldn't save comes back, and only into an untouched composer.
 */
export function useComposerSubmit(args: {
  blocked: string | undefined;
  current: ComposerDraft;
  /** The current catalog, so a `/name` typed without the menu still goes as its mention. */
  entries: readonly CatalogEntry[] | undefined;
  attachments: ReturnType<typeof useAttachments>;
  /** Browser annotations waiting in the draft; they travel after the words. */
  annotations: ReturnType<typeof useComposerAnnotations>;
  saved: ReturnType<typeof useDraftPersistence>;
  draftKey: string | undefined;
  storage: KeyValueStorage | undefined;
  onSubmit(draft: Draft): Promise<boolean>;
  /** Empty the composer for the next message. */
  clear(): void;
  /** Put a draft's text back in place; its files are already back. */
  takeText(draft: ComposerDraft): void;
  /** Remount on a draft whose files must be re-added. */
  replace(draft: ComposerDraft): void;
}): (opposite: boolean) => void {
  "use no memo";
  const { current, attachments, saved, draftKey, storage } = args;
  const restore = useEffectEvent((before: ReturnedDraft, draft: Draft) => {
    const next = mergeReturnedDraft(current, before);
    saved.discard();
    if (draftKey) writeDraft(storage, draftKey, next);
    if (draft.files.restore) {
      draft.files.restore();
      args.takeText(next);
    } else args.replace(next);
  });
  return (opposite) => {
    if (args.blocked) return;
    const content = composerContent({
      ...current,
      tokens: withTypedCommand(current.text, current.tokens ?? [], args.entries),
      attachments: attachments.ready,
    });
    const annotated = args.annotations.handOff();
    const message = withAnnotations(
      { input: content.input, files: attachments.handOff() },
      annotated,
      (image) => image,
    );
    const draft: Draft = {
      text: current.text,
      ...content,
      input: message.input,
      files: {
        ...message.files,
        uploading: attachments.items.filter((file) => file.state === "uploading").length,
      },
      opposite,
    };
    const returned: ReturnedDraft = {
      text: current.text,
      tokens: current.tokens,
      mentions: current.mentions,
      attachments: attachments.ready,
      annotations: annotated?.returned,
    };
    saved.hold();
    args.clear();
    void args.onSubmit(draft).then((sent) => {
      if (!saved.finish()) {
        if (!sent && draftKey) {
          const stored = readDraft(storage, draftKey);
          if (fingerprint(stored) !== fingerprint(returned))
            restoreReturnedDraft(storage, draftKey, returned);
        }
        return;
      }
      if (!sent) restore(returned, draft);
    });
  };
}
