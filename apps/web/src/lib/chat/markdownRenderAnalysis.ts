import type { ChatMessageStreamingTextState } from "../../types";
import { fnv1a32 } from "../diffRendering";
import { buildLargeMarkdownPreviewText, shouldUseLargeMarkdownPreview } from "./messageText";

const INLINE_MARKDOWN_SIGNAL_REGEX =
  /`|\*\*?|\[[^\]]+\]\(|!\[|https?:\/\/|www\.|<\w[\s\S]*?>|<\/\w+>/i;
const BLOCK_MARKDOWN_SIGNAL_REGEX =
  /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s+|\d+[.)]\s+|>\s+|```|~~~|\|.+\|)/;
const ASYNC_MARKDOWN_LAYOUT_SIGNAL_REGEX = /```|~~~|!\[|<img|<video|<iframe|<details|<table/i;
const MARKDOWN_ANALYSIS_CACHE_SNIPPET_CHARS = 256;
export const MIN_WORKER_MARKDOWN_ANALYSIS_CHARS = 8_192;
export const MIN_WORKER_MARKDOWN_ANALYSIS_LINES = 256;

export interface MarkdownRenderAnalysisInput {
  readonly text: string;
  readonly isStreaming: boolean;
  readonly renderPlainText: boolean;
  readonly streamingTextState?: Pick<
    ChatMessageStreamingTextState,
    "totalLineCount" | "truncatedCharCount" | "truncatedLineCount"
  >;
}

export interface MarkdownRenderAnalysisResult {
  readonly shouldFastPathPlainText: boolean;
  readonly shouldObserveLayout: boolean;
  readonly useLargePreview: boolean;
  readonly largePreviewText: string | null;
  readonly usesStreamingPreview: boolean;
}

export function shouldUsePlainTextMarkdownFastPath(text: string): boolean {
  if (text.length === 0) {
    return true;
  }
  return !INLINE_MARKDOWN_SIGNAL_REGEX.test(text) && !BLOCK_MARKDOWN_SIGNAL_REGEX.test(text);
}

export function shouldObserveMarkdownLayout(input: {
  readonly text: string;
  readonly isStreaming: boolean;
  readonly renderPlainText: boolean;
  readonly useLargePreview: boolean;
}): boolean {
  if (input.isStreaming || input.renderPlainText || input.useLargePreview) {
    return true;
  }
  return ASYNC_MARKDOWN_LAYOUT_SIGNAL_REGEX.test(input.text);
}

export function analyzeMarkdownRender(
  input: MarkdownRenderAnalysisInput,
): MarkdownRenderAnalysisResult {
  const usesStreamingPreview =
    input.isStreaming &&
    ((input.streamingTextState?.truncatedCharCount ?? 0) > 0 ||
      (input.streamingTextState?.truncatedLineCount ?? 0) > 0);
  const useLargePreview =
    !input.isStreaming &&
    shouldUseLargeMarkdownPreview(input.text, input.streamingTextState?.totalLineCount);
  const shouldFastPathPlainText =
    !input.isStreaming &&
    !input.renderPlainText &&
    !useLargePreview &&
    shouldUsePlainTextMarkdownFastPath(input.text);

  return {
    shouldFastPathPlainText,
    shouldObserveLayout: shouldObserveMarkdownLayout({
      text: input.text,
      isStreaming: input.isStreaming,
      renderPlainText: input.renderPlainText,
      useLargePreview,
    }),
    useLargePreview,
    largePreviewText: useLargePreview ? buildLargeMarkdownPreviewText(input.text) : null,
    usesStreamingPreview,
  };
}

export function shouldWorkerizeMarkdownRenderAnalysis(input: MarkdownRenderAnalysisInput): boolean {
  if (input.renderPlainText || input.isStreaming) {
    return false;
  }
  return (
    input.text.length >= MIN_WORKER_MARKDOWN_ANALYSIS_CHARS ||
    (input.streamingTextState?.totalLineCount ?? 0) >= MIN_WORKER_MARKDOWN_ANALYSIS_LINES
  );
}

function buildMarkdownRenderAnalysisFingerprint(text: string): string {
  if (text.length <= MARKDOWN_ANALYSIS_CACHE_SNIPPET_CHARS * 2) {
    return `${text.length}:${fnv1a32(text).toString(36)}`;
  }
  const head = text.slice(0, MARKDOWN_ANALYSIS_CACHE_SNIPPET_CHARS);
  const tail = text.slice(-MARKDOWN_ANALYSIS_CACHE_SNIPPET_CHARS);
  const sample = `${head}\0${tail}`;
  return `${text.length}:${fnv1a32(sample).toString(36)}`;
}

export function buildMarkdownRenderAnalysisCacheKey(
  input: MarkdownRenderAnalysisInput,
  stableKey?: string,
): string {
  const identity = stableKey ?? buildMarkdownRenderAnalysisFingerprint(input.text);
  return [
    "markdown-analysis:v1",
    identity,
    input.isStreaming ? "streaming" : "complete",
    input.renderPlainText ? "plain" : "rich",
    input.streamingTextState?.totalLineCount ?? -1,
    input.streamingTextState?.truncatedCharCount ?? -1,
    input.streamingTextState?.truncatedLineCount ?? -1,
  ].join(":");
}
