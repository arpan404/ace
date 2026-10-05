import { inputText, localAttachment, type ReturnedDraft } from "./send-store.ts";

export type SendPayload = Extract<
  import("@ace/protocol").CommandPayload,
  { type: "thread.send" | "thread.create" }
>;

/** What Edit gives back to the composer: the text, mentions, files and picks it carried. */
export function draftOf(payload: SendPayload): ReturnedDraft {
  return {
    text: inputText(payload.input),
    mentions: payload.context?.mentions.map((mention) => mention.path) ?? [],
    attachments: (payload.context?.attachments ?? []).map((file) => ({
      sha256: file.sha256,
      name: localAttachment(file.sha256)?.name ?? "Attachment",
    })),
    options: payload.options,
  };
}
