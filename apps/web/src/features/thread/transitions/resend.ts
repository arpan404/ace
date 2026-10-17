import { ThreadId, type CommandPayload, type ContentPart, type Item } from "@ace/protocol";

export type ResendPayload = Extract<CommandPayload, { type: "thread.send" }>;

/** The person's message again, as input: its text, images and files. */
export function resendInput(item: Item | undefined): ContentPart[] {
  if (item?.type !== "message") return [];
  return item.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : part,
  );
}

/**
 * The person's message `item` sent to its thread again as a new turn, with the files it carried;
 * undefined when it carries nothing to send.
 */
export function resendPayload(threadId: string, item: Item | undefined): ResendPayload | undefined {
  const input = resendInput(item);
  if (!input.length || item?.type !== "message") return undefined;
  return {
    type: "thread.send",
    threadId: ThreadId.parse(threadId),
    input,
    trigger: "user",
    ...(item.attachments?.length
      ? {
          context: {
            mentions: [],
            attachments: item.attachments.map((file) => ({ sha256: file.sha256 })),
          },
        }
      : {}),
  };
}
