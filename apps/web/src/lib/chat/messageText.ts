import type { ChatMessage, ChatMessageStreamingTextState } from "../../types";

const STREAMING_PREVIEW_MAX_CHARS = 120_000;
const STREAMING_PREVIEW_MAX_LINES = 2_000;
const STREAMING_CHUNK_MERGE_MAX_CHARS = 8_192;
const LARGE_MARKDOWN_AUTO_RENDER_CHAR_THRESHOLD = 200_000;
const LARGE_MARKDOWN_AUTO_RENDER_LINE_THRESHOLD = 4_000;
const LARGE_MARKDOWN_PREVIEW_HEAD_MAX_CHARS = 48_000;
const LARGE_MARKDOWN_PREVIEW_HEAD_MAX_LINES = 120;
const LARGE_MARKDOWN_PREVIEW_TAIL_MAX_CHARS = 72_000;
const LARGE_MARKDOWN_PREVIEW_TAIL_MAX_LINES = 180;
const LARGE_MARKDOWN_PREVIEW_SEPARATOR =
  "\n\n[... large response collapsed for faster rendering ...]\n\n";

export const COLLAPSED_ASSISTANT_PREVIEW_MAX_HEIGHT_PX = 384;

export type AssistantMessageRenderHint = "full-text" | "streaming-preview" | "large-preview";

function countLineBreaks(text: string): number {
  let lineBreaks = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineBreaks += 1;
    }
  }
  return lineBreaks;
}

export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return countLineBreaks(text) + 1;
}

function mergeStreamingChunks(
  chunks: ReadonlyArray<string>,
  nextChunk: string,
): ReadonlyArray<string> {
  if (nextChunk.length === 0) {
    return chunks;
  }

  const previousChunk = chunks.at(-1);
  if (previousChunk && previousChunk.length + nextChunk.length <= STREAMING_CHUNK_MERGE_MAX_CHARS) {
    const nextChunks = [...chunks];
    nextChunks[nextChunks.length - 1] = `${previousChunk}${nextChunk}`;
    return nextChunks;
  }

  return [...chunks, nextChunk];
}

function alignPreviewStartToLineBoundary(text: string, start: number): number {
  if (start <= 0 || start >= text.length) {
    return Math.max(0, Math.min(start, text.length));
  }

  const nextLineBreakIndex = text.indexOf("\n", start);
  return nextLineBreakIndex === -1 ? start : nextLineBreakIndex + 1;
}

function trimStreamingPreviewWindow(
  text: string,
  previewLineCount: number,
  totalLength: number,
  totalLineCount: number,
): Pick<
  ChatMessageStreamingTextState,
  "previewText" | "previewLineCount" | "truncatedCharCount" | "truncatedLineCount"
> {
  if (text.length === 0) {
    return {
      previewText: "",
      previewLineCount: 0,
      truncatedCharCount: 0,
      truncatedLineCount: 0,
    };
  }

  let previewStart = 0;
  let nextPreviewLineCount = previewLineCount;

  if (text.length > STREAMING_PREVIEW_MAX_CHARS) {
    previewStart = alignPreviewStartToLineBoundary(text, text.length - STREAMING_PREVIEW_MAX_CHARS);
    if (previewStart > 0) {
      nextPreviewLineCount = Math.max(
        previewLineCount - countLineBreaks(text.slice(0, previewStart)),
        0,
      );
    }
  }

  const overflowLineCount = nextPreviewLineCount - STREAMING_PREVIEW_MAX_LINES;
  if (overflowLineCount > 0) {
    let removedLineBreaks = 0;
    for (let index = previewStart; index < text.length; index += 1) {
      if (text.charCodeAt(index) !== 10) {
        continue;
      }
      removedLineBreaks += 1;
      previewStart = index + 1;
      if (removedLineBreaks >= overflowLineCount) {
        break;
      }
    }
    nextPreviewLineCount = Math.max(nextPreviewLineCount - removedLineBreaks, 0);
  }

  const previewText = text.slice(previewStart);
  const resolvedPreviewLineCount = previewText.length === 0 ? 0 : Math.max(nextPreviewLineCount, 1);
  return {
    previewText,
    previewLineCount: resolvedPreviewLineCount,
    truncatedCharCount: Math.max(totalLength - previewText.length, 0),
    truncatedLineCount: Math.max(totalLineCount - resolvedPreviewLineCount, 0),
  };
}

function buildStreamingPreviewWindow(
  text: string,
  totalLength: number,
  totalLineCount: number,
): Pick<
  ChatMessageStreamingTextState,
  "previewText" | "previewLineCount" | "truncatedCharCount" | "truncatedLineCount"
> {
  return trimStreamingPreviewWindow(text, countTextLines(text), totalLength, totalLineCount);
}

export function createChatMessageStreamingTextState(
  initialText: string,
): ChatMessageStreamingTextState {
  const totalLength = initialText.length;
  const totalLineCount = countTextLines(initialText);
  return {
    chunks: initialText.length > 0 ? [initialText] : [],
    totalLength,
    totalLineCount,
    ...buildStreamingPreviewWindow(initialText, totalLength, totalLineCount),
  };
}

export function appendChatMessageStreamingTextState(
  previous: ChatMessageStreamingTextState,
  nextChunk: string,
): ChatMessageStreamingTextState {
  if (nextChunk.length === 0) {
    return previous;
  }

  const totalLength = previous.totalLength + nextChunk.length;
  const totalLineCount =
    totalLength === nextChunk.length
      ? countTextLines(nextChunk)
      : previous.totalLineCount + countLineBreaks(nextChunk);
  const nextPreviewSource = `${previous.previewText}${nextChunk}`;
  const nextPreviewLineCount =
    previous.previewText.length === 0
      ? countTextLines(nextPreviewSource)
      : previous.previewLineCount + countLineBreaks(nextChunk);

  return {
    chunks: mergeStreamingChunks(previous.chunks, nextChunk),
    totalLength,
    totalLineCount,
    ...trimStreamingPreviewWindow(
      nextPreviewSource,
      nextPreviewLineCount,
      totalLength,
      totalLineCount,
    ),
  };
}

export function getChatMessageRenderableText(
  message: Pick<ChatMessage, "text" | "streaming" | "streamingTextState">,
): string {
  if (message.streaming && message.streamingTextState) {
    return message.streamingTextState.previewText;
  }
  return message.text;
}

export function getChatMessageTextLength(
  message: Pick<ChatMessage, "text" | "streamingTextState">,
): number {
  return message.streamingTextState?.totalLength ?? message.text.length;
}

export function getChatMessageFullText(
  message: Pick<ChatMessage, "text" | "streamingTextState">,
): string {
  if (!message.streamingTextState) {
    return message.text;
  }
  return message.streamingTextState.chunks.join("");
}

export function finalizeChatMessageText(
  message: Pick<ChatMessage, "text" | "streamingTextState">,
  finalText: string,
): string {
  if (finalText.length > 0) {
    return finalText;
  }
  return getChatMessageFullText(message);
}

export function shouldUseLargeMarkdownPreview(text: string, lineCount?: number): boolean {
  return (
    text.length > LARGE_MARKDOWN_AUTO_RENDER_CHAR_THRESHOLD ||
    (typeof lineCount === "number" && lineCount > LARGE_MARKDOWN_AUTO_RENDER_LINE_THRESHOLD)
  );
}

function findLeadingPreviewEnd(text: string): number {
  let lineBreaks = 0;
  const charLimit = Math.min(text.length, LARGE_MARKDOWN_PREVIEW_HEAD_MAX_CHARS);

  for (let index = 0; index < charLimit; index += 1) {
    if (text.charCodeAt(index) !== 10) {
      continue;
    }
    lineBreaks += 1;
    if (lineBreaks >= LARGE_MARKDOWN_PREVIEW_HEAD_MAX_LINES) {
      return index + 1;
    }
  }

  if (charLimit >= text.length) {
    return text.length;
  }

  const nextLineBreakIndex = text.indexOf("\n", charLimit);
  return nextLineBreakIndex === -1 ? charLimit : nextLineBreakIndex + 1;
}

function findTrailingPreviewStart(text: string): number {
  let lineBreaks = 0;
  const charFloor = Math.max(0, text.length - LARGE_MARKDOWN_PREVIEW_TAIL_MAX_CHARS);

  for (let index = text.length; index > charFloor; index -= 1) {
    if (text.charCodeAt(index - 1) !== 10) {
      continue;
    }
    lineBreaks += 1;
    if (lineBreaks >= LARGE_MARKDOWN_PREVIEW_TAIL_MAX_LINES) {
      return index;
    }
  }

  if (charFloor === 0) {
    return 0;
  }

  const previousLineBreakIndex = text.lastIndexOf("\n", charFloor - 1);
  return previousLineBreakIndex === -1 ? charFloor : previousLineBreakIndex + 1;
}

export function buildLargeMarkdownPreviewText(text: string): string {
  const leadingEnd = findLeadingPreviewEnd(text);
  const trailingStart = findTrailingPreviewStart(text);
  if (leadingEnd >= trailingStart) {
    return text;
  }
  return `${text.slice(0, leadingEnd)}${LARGE_MARKDOWN_PREVIEW_SEPARATOR}${text.slice(trailingStart)}`;
}

export function resolveAssistantMessageRenderHint(
  message: Pick<ChatMessage, "text" | "streaming" | "streamingTextState">,
): AssistantMessageRenderHint {
  if (
    message.streaming &&
    message.streamingTextState &&
    (message.streamingTextState.truncatedCharCount > 0 ||
      message.streamingTextState.truncatedLineCount > 0)
  ) {
    return "streaming-preview";
  }

  if (
    !message.streaming &&
    shouldUseLargeMarkdownPreview(message.text, message.streamingTextState?.totalLineCount)
  ) {
    return "large-preview";
  }

  return "full-text";
}

export function estimateCollapsedAssistantPreviewHeight(
  hint: Extract<AssistantMessageRenderHint, "streaming-preview" | "large-preview">,
): number {
  return hint === "large-preview"
    ? COLLAPSED_ASSISTANT_PREVIEW_MAX_HEIGHT_PX + 84
    : COLLAPSED_ASSISTANT_PREVIEW_MAX_HEIGHT_PX + 44;
}
