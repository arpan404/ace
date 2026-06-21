import { describe, expect, it } from "vitest";

import {
  analyzeMarkdownRender,
  buildMarkdownRenderAnalysisCacheKey,
  shouldUsePlainTextMarkdownFastPath,
  shouldWorkerizeMarkdownRenderAnalysis,
} from "./markdownRenderAnalysis";

describe("markdownRenderAnalysis", () => {
  it("detects plain text fast path for non-markdown content", () => {
    expect(shouldUsePlainTextMarkdownFastPath("Plain assistant response.")).toBe(true);
  });

  it("does not use plain text fast path when markdown syntax is present", () => {
    expect(shouldUsePlainTextMarkdownFastPath("**bold**")).toBe(false);
  });

  it("builds preview text for large completed markdown", () => {
    const text = `${"# Heading\n".repeat(2000)}tail`;
    const result = analyzeMarkdownRender({
      text,
      isStreaming: false,
      renderPlainText: false,
      streamingTextState: {
        totalLineCount: 4001,
        truncatedCharCount: 0,
        truncatedLineCount: 0,
      },
    });
    expect(result.useLargePreview).toBe(true);
    expect(result.largePreviewText).toContain("large response collapsed");
  });

  it("uses stable cache keys when provided", () => {
    const input = {
      text: "hello",
      isStreaming: false,
      renderPlainText: false,
    } as const;
    expect(buildMarkdownRenderAnalysisCacheKey(input, "message-1")).toContain("message-1");
  });

  it("workerizes sufficiently large completed markdown", () => {
    expect(
      shouldWorkerizeMarkdownRenderAnalysis({
        text: "a".repeat(10_000),
        isStreaming: false,
        renderPlainText: false,
      }),
    ).toBe(true);
    expect(
      shouldWorkerizeMarkdownRenderAnalysis({
        text: "short",
        isStreaming: false,
        renderPlainText: false,
      }),
    ).toBe(false);
  });
});
