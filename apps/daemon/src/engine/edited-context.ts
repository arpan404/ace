import type { ContentPart, MessageContext } from "@ace/protocol";

function text(input: readonly ContentPart[]): string {
  return input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * The context a queued message keeps through an edit. A file's spot (`at`) is an offset into
 * the old text, so when the text changes and the edit carries the old context unchanged, the
 * files go after the new text, as a message without spots always has. An edit that sends a new
 * context sets its own spots.
 */
export function editedContext(
  old: { input: readonly ContentPart[]; context?: MessageContext | undefined },
  input: readonly ContentPart[],
  context: MessageContext | undefined,
): MessageContext | undefined {
  if (!context || text(old.input) === text(input)) return context;
  if (JSON.stringify(context) !== JSON.stringify(old.context)) return context;
  return { ...context, attachments: context.attachments.map(({ sha256 }) => ({ sha256 })) };
}
