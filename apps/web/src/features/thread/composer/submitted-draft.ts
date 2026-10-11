import type { ContentPart, MessageContext } from "@ace/protocol";
import { composerInput, type ComposerDraft, type KeyValueStorage } from "@ace/ui-core";
import { mentionsIn } from "./draft.ts";
import { readDraft, writeDraft } from "./draft-store.ts";

export interface SubmittedDraft {
  input: readonly ContentPart[];
  context?: MessageContext | undefined;
}

/** The message content, independent of the model, account or new daemon draft scope. */
export function composerContent(draft: ComposerDraft) {
  const tokens = draft.tokens ?? [];
  return {
    input: composerInput(draft.text, tokens),
    threadRefs: tokens.flatMap((token) => (token.thread ? [token.thread] : [])),
    mentions: [
      ...mentionsIn(draft.text, new Set(draft.mentions)).filter(
        (mention) => !tokens.some((token) => token.file?.path === mention.path),
      ),
      ...tokens.flatMap((token) => (token.file ? [token.file] : [])),
    ].filter(
      (mention, index, all) =>
        all.findIndex(
          (other) =>
            other.path === mention.path &&
            JSON.stringify(other.lines) === JSON.stringify(mention.lines),
        ) === index,
    ),
    attachments: draft.attachments.map((file) => ({ sha256: file.sha256 })),
  };
}
function content(sent: SubmittedDraft) {
  return {
    input: sent.input,
    threadRefs: sent.context?.items ?? [],
    mentions: sent.context?.mentions ?? [],
    attachments: sent.context?.attachments ?? [],
  };
}
export function sameSubmittedDraft(a: SubmittedDraft, b: SubmittedDraft): boolean {
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}
export function matchesSubmittedDraft(draft: ComposerDraft, sent: SubmittedDraft): boolean {
  return JSON.stringify(composerContent(draft)) === JSON.stringify(content(sent));
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
