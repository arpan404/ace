import {
  boundedAnnotations,
  returnedAnnotations,
  splitAnnotationParts,
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
  const split = splitAnnotationParts(payload.input);
  const files = (payload.context?.attachments ?? []).map((file) => ({
    sha256: file.sha256,
    name: localAttachment(file.sha256)?.name ?? "Attachment",
  }));
  const annotated = split.annotations && returnedAnnotations(split.annotations, files);
  return {
    ...tokensFromInput(split.parts),
    mentions: payload.context?.mentions.map((mention) => mention.path) ?? [],
    attachments: annotated?.attachments ?? files,
    ...(annotated ? { annotations: annotated.annotations } : {}),
    options: payload.options,
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
