import type { ContentPart } from "@ace/protocol";
import {
  boundedAnnotations,
  mergeQuotes,
  placeAttachmentMarkers,
  returnedAnnotations,
  returnedQuotes,
  splitAnnotationParts,
  splitQuoteParts,
  textPartsText,
  tokensFromInput,
  type ComposerDraft,
  type DraftAnnotations,
  type KeyValueStorage,
} from "@ace/ui-core";
import { localAttachment, returnDraft, type ReturnedDraft } from "./send-store.ts";
import { readDraft, writeDraft } from "./draft-store.ts";

export type SendPayload = Extract<
  import("@ace/protocol").CommandPayload,
  { type: "thread.send" | "thread.create" }
>;

/**
 * What Edit gives back to the composer: the text, mentions, files and picks it carried, and its
 * browser annotations rebuilt from their block, with their images taken out of the files.
 */
export function draftOf(payload: SendPayload): ReturnedDraft {
  return draftFromMessage({
    input: payload.input,
    mentions: payload.context?.mentions.map((mention) => mention.path) ?? [],
    files: (payload.context?.attachments ?? []).map((file) => ({
      sha256: file.sha256,
      at: file.at,
      name: localAttachment(file.sha256)?.name ?? "Attachment",
    })),
    options: payload.options,
  });
}

/**
 * A message as the composer takes it back to edit: its quotes and annotations out of the words,
 * and each file's marker where it was sent from. File offsets count the quoted block before the
 * words, so the words come back with the markers moved back by its length. Pure.
 */
export function draftFromMessage(message: {
  input: readonly ContentPart[];
  mentions: string[];
  files: readonly { sha256: string; at?: number | undefined; name: string }[];
  options?: ReturnedDraft["options"];
}): ReturnedDraft {
  const annotatedParts = splitAnnotationParts(message.input);
  const quoted = splitQuoteParts(annotatedParts.parts);
  const split = { ...annotatedParts, parts: quoted.parts };
  const files = message.files.map(({ sha256, name }) => ({ sha256, name }));
  const annotated = split.annotations && returnedAnnotations(split.annotations, files);
  const lead = textPartsText(annotatedParts.parts).length - textPartsText(quoted.parts).length;
  const words = tokensFromInput(split.parts);
  return {
    ...placeAttachmentMarkers(
      words.text,
      words.tokens,
      message.files.map((file) => ({
        ...file,
        at: file.at === undefined ? undefined : Math.max(0, file.at - lead),
      })),
    ),
    mentions: message.mentions,
    attachments: annotated?.attachments ?? files,
    ...(annotated ? { annotations: annotated.annotations } : {}),
    ...(quoted.quotes ? { quotes: returnedQuotes(quoted.quotes, (index) => `sent:${index}`) } : {}),
    options: message.options,
  };
}

/** Two drafts' annotations together, without repeating a record or a page's screenshot. */
function mergeAnnotations(
  current: DraftAnnotations | undefined,
  returned: DraftAnnotations | undefined,
): DraftAnnotations | undefined {
  if (!returned) return current;
  const ids = new Set(current?.items.map((item) => item.annotation.id));
  const urls = new Set(current?.pages.map((page) => page.url));
  return boundedAnnotations({
    items: [
      ...(current?.items ?? []),
      ...returned.items.filter((item) => !ids.has(item.annotation.id)),
    ],
    pages: [...(current?.pages ?? []), ...returned.pages.filter((page) => !urls.has(page.url))],
  });
}

/** A returned message joins the person's current draft instead of replacing work in progress. */
export function mergeReturnedDraft(
  current: ComposerDraft | undefined,
  returned: ReturnedDraft,
): ComposerDraft {
  const text = current?.text ?? "";
  const offset = text.trim() ? text.trimEnd().length + 2 : 0;
  return {
    text: offset ? `${text.trimEnd()}\n\n${returned.text}` : returned.text,
    mentions: [...new Set([...(current?.mentions ?? []), ...returned.mentions])],
    tokens: [
      ...(current?.tokens ?? []),
      ...(returned.tokens ?? []).map((token) =>
        Object.assign({}, token, {
          start: token.start + offset,
          end: token.end + offset,
        }),
      ),
    ],
    attachments: [
      ...new Map(
        [...(current?.attachments ?? []), ...returned.attachments].map((file) => [
          file.sha256,
          file,
        ]),
      ).values(),
    ],
    annotations: mergeAnnotations(current?.annotations, returned.annotations),
    quotes: mergeQuotes(current?.quotes, returned.quotes),
  };
}

/** The composer may have unmounted while the daemon was answering: preserve its stored draft too. */
export function restoreReturnedDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  returned: ReturnedDraft,
): boolean {
  const saved = returnDraft(key, returned);
  return saved ?? writeDraft(storage, key, mergeReturnedDraft(readDraft(storage, key), returned));
}
