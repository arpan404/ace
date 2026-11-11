import type { ContentPart, MessageContext } from "@ace/protocol";
import {
  composerInput,
  referenceContext,
  takeAttachmentMarkers,
  type ComposerDraft,
  type KeyValueStorage,
} from "@ace/ui-core";
import { mentionsIn } from "./draft.ts";
import { readDraft, writeDraft } from "./draft-store.ts";

export interface SubmittedDraft {
  input: readonly ContentPart[];
  context?: MessageContext | undefined;
}

/**
 * The message content, independent of the model, account or new daemon draft scope: its words
 * without the file markers, and each marked file's offset in them (`at`, counted in text parts;
 * `positions` has them by chip key, for the files still uploading).
 */
export function composerContent(draft: ComposerDraft) {
  const marked = takeAttachmentMarkers(draft.text, draft.tokens ?? []);
  const { tokens } = marked;
  const references = referenceContext(tokens, mentionsIn(marked.text, new Set(draft.mentions)));
  const at = new Map(marked.files.flatMap((file) => (file.sha256 ? [[file.sha256, file.at]] : [])));
  return {
    text: marked.text,
    input: composerInput(marked.text, tokens),
    threadRefs: references.items,
    mentions: references.mentions,
    attachments: draft.attachments.map((file) => {
      const position = at.get(file.sha256);
      return position === undefined
        ? { sha256: file.sha256 }
        : { sha256: file.sha256, at: position };
    }),
    positions: new Map(
      marked.files.flatMap((file) => (file.key === undefined ? [] : [[file.key, file.at]])),
    ),
  };
}
/** What two sends are compared by: words, references and which files, not where files sit. */
function compared(message: {
  input: readonly ContentPart[];
  threadRefs: readonly unknown[];
  mentions: readonly unknown[];
  attachments: readonly { sha256: string }[];
}) {
  return JSON.stringify([
    message.input,
    message.threadRefs,
    message.mentions,
    message.attachments.map((file) => file.sha256),
  ]);
}
function content(sent: SubmittedDraft) {
  return {
    input: sent.input,
    // Annotation refs come from the draft's annotations, which this compares separately.
    threadRefs: (sent.context?.items ?? []).filter((item) => item.type !== "browser_annotations"),
    mentions: sent.context?.mentions ?? [],
    attachments: sent.context?.attachments ?? [],
  };
}
export function sameSubmittedDraft(a: SubmittedDraft, b: SubmittedDraft): boolean {
  return compared(content(a)) === compared(content(b));
}
export function matchesSubmittedDraft(draft: ComposerDraft, sent: SubmittedDraft): boolean {
  return compared(composerContent(draft)) === compared(content(sent));
}
/** A confirmed send removes only its own unsent copy, preserving a newer message. */
export function discardSubmittedDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  sent: SubmittedDraft,
): void {
  const draft = readDraft(storage, key);
  if (draft && matchesSubmittedDraft(draft, sent)) writeDraft(storage, key, undefined);
}
