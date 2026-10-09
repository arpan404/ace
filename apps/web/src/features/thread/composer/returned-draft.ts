import { tokensFromInput, type ComposerDraft, type KeyValueStorage } from "@ace/ui-core";
import { localAttachment, returnDraft, type ReturnedDraft } from "./send-store.ts";
import { readDraft, writeDraft } from "./draft-store.ts";

export type SendPayload = Extract<
  import("@ace/protocol").CommandPayload,
  { type: "thread.send" | "thread.create" }
>;

/** What Edit gives back to the composer: the text, mentions, files and picks it carried. */
export function draftOf(payload: SendPayload): ReturnedDraft {
  return {
    ...tokensFromInput(payload.input),
    mentions: payload.context?.mentions.map((mention) => mention.path) ?? [],
    attachments: (payload.context?.attachments ?? []).map((file) => ({
      sha256: file.sha256,
      name: localAttachment(file.sha256)?.name ?? "Attachment",
    })),
    options: payload.options,
  };
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
  };
}

/** The composer may have unmounted while the daemon was answering: preserve its stored draft too. */
export function restoreReturnedDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  returned: ReturnedDraft,
): void {
  if (!returnDraft(key, returned))
    writeDraft(storage, key, mergeReturnedDraft(readDraft(storage, key), returned));
}
