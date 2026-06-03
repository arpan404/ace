import * as Schema from "effect/Schema";

export const PINNED_MESSAGES_STORAGE_KEY = "ace:pinned-messages:v1";

export const PinnedMessageSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  kind: Schema.optional(Schema.Literals(["message", "selection"])),
  title: Schema.String,
  preview: Schema.String,
  selectedText: Schema.optional(Schema.String),
  checked: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const PinnedMessagesSchema = Schema.Array(PinnedMessageSchema);

export type PinnedMessage = Schema.Schema.Type<typeof PinnedMessageSchema>;
export type PinnedMessages = Schema.Schema.Type<typeof PinnedMessagesSchema>;
export type PinnedMessageNavigationTarget =
  | { kind: "message" }
  | { kind: "selection"; selectedText?: string };

export const EMPTY_PINNED_MESSAGES: PinnedMessages = [];

function normalizePinnedMessageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncatePinnedMessageText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function resolvePinnedMessageTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return truncatePinnedMessageText(firstLine ?? "Pinned message", 72);
}

export function resolvePinnedMessagePreview(text: string): string {
  return truncatePinnedMessageText(normalizePinnedMessageText(text), 140);
}

export function getPinnedMessageId(input: { threadId: string; messageId: string }): string {
  return `${input.threadId}:${input.messageId}`;
}

function hashPinnedMessageText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function upsertPinnedMessage(
  messages: PinnedMessages,
  input: { threadId: string; messageId: string; text: string },
): PinnedMessages {
  const id = getPinnedMessageId(input);
  const now = Date.now();
  const title = resolvePinnedMessageTitle(input.text);
  const preview = resolvePinnedMessagePreview(input.text);
  const existingIndex = messages.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== existingIndex) return message;
      const { selectedText: _selectedText, ...messageWithoutSelection } = message;
      return {
        ...messageWithoutSelection,
        kind: "message",
        preview,
        title,
        updatedAt: now,
      };
    });
  }

  return [
    {
      id,
      threadId: input.threadId,
      messageId: input.messageId,
      kind: "message",
      title,
      preview,
      checked: false,
      createdAt: now,
      updatedAt: now,
    },
    ...messages,
  ];
}

export function upsertPinnedSelectionMessage(
  messages: PinnedMessages,
  input: { threadId: string; messageId: string; text: string },
): PinnedMessages {
  const normalizedText = normalizePinnedMessageText(input.text);
  const id = `${getPinnedMessageId(input)}:selection:${hashPinnedMessageText(normalizedText)}`;
  const now = Date.now();
  const title = resolvePinnedMessageTitle(input.text);
  const preview = resolvePinnedMessagePreview(input.text);
  const existingIndex = messages.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    return messages.map((message, index) =>
      index === existingIndex
        ? {
            ...message,
            kind: "selection",
            preview,
            selectedText: normalizedText,
            title,
            updatedAt: now,
          }
        : message,
    );
  }

  return [
    {
      id,
      threadId: input.threadId,
      messageId: input.messageId,
      kind: "selection",
      title,
      preview,
      selectedText: normalizedText,
      checked: false,
      createdAt: now,
      updatedAt: now,
    },
    ...messages,
  ];
}

export function removePinnedMessage(
  messages: PinnedMessages,
  input: { threadId: string; messageId: string },
): PinnedMessages {
  const id = getPinnedMessageId(input);
  return messages.filter((message) => message.id !== id);
}

export function removePinnedMessageById(messages: PinnedMessages, id: string): PinnedMessages {
  return messages.filter((message) => message.id !== id);
}

export function togglePinnedMessageChecked(messages: PinnedMessages, id: string): PinnedMessages {
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          checked: !message.checked,
          updatedAt: Date.now(),
        }
      : message,
  );
}
