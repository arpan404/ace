import { describe, expect, it } from "vitest";

import {
  appendChatMessageStreamingTextState,
  buildLargeMarkdownPreviewText,
  createChatMessageStreamingTextState,
  finalizeChatMessageText,
  getChatMessageFullText,
  resolveAssistantMessageRenderHint,
} from "./messageText";

describe("messageText", () => {
  it("keeps full streamed text while truncating the live preview window", () => {
    const fullText = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
    const midpoint = Math.floor(fullText.length / 2);
    let state = createChatMessageStreamingTextState(fullText.slice(0, midpoint));
    state = appendChatMessageStreamingTextState(state, fullText.slice(midpoint));

    expect(getChatMessageFullText({ text: "", streamingTextState: state })).toBe(fullText);
    expect(state.truncatedLineCount).toBeGreaterThan(0);
    expect(state.previewLineCount).toBeLessThan(state.totalLineCount);
    expect(state.previewText).toContain("line 2500");
  });

  it("uses the streaming preview hint once the live preview is truncated", () => {
    const fullText = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
    let state = createChatMessageStreamingTextState("");
    state = appendChatMessageStreamingTextState(state, fullText);

    expect(
      resolveAssistantMessageRenderHint({
        text: "",
        streaming: true,
        streamingTextState: state,
      }),
    ).toBe("streaming-preview");
  });

  it("preserves the trailing preview window when many small chunks stream in", () => {
    const streamedLines = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}\n`);
    let state = createChatMessageStreamingTextState("");

    for (const chunk of streamedLines) {
      state = appendChatMessageStreamingTextState(state, chunk);
    }

    const fullText = streamedLines.join("");
    expect(getChatMessageFullText({ text: "", streamingTextState: state })).toBe(fullText);
    expect(state.truncatedLineCount).toBeGreaterThan(0);
    expect(state.previewLineCount).toBeLessThan(state.totalLineCount);
    expect(state.previewText).toContain("line 2500");
  });

  it("keeps streamed text when completion payload only contains trailing content", () => {
    let state = createChatMessageStreamingTextState("hello");
    state = appendChatMessageStreamingTextState(state, " world");

    expect(
      finalizeChatMessageText(
        {
          text: "",
          streamingTextState: state,
        },
        "!",
      ),
    ).toBe("hello world!");
  });

  it("prefers full completion text when streamed markdown was escaped", () => {
    let state = createChatMessageStreamingTextState("\\*\\*Audit Result\\*\\*");
    state = appendChatMessageStreamingTextState(
      state,
      "\n- \\[ChatView.tsx\\]\\(/repo/apps/web/src/components/ChatView.tsx\\) uses \\`memo\\`.",
    );

    expect(
      finalizeChatMessageText(
        {
          text: "",
          streamingTextState: state,
        },
        "**Audit Result**\n- [ChatView.tsx](/repo/apps/web/src/components/ChatView.tsx) uses `memo`.",
      ),
    ).toBe(
      "**Audit Result**\n- [ChatView.tsx](/repo/apps/web/src/components/ChatView.tsx) uses `memo`.",
    );
  });

  it("builds a collapsed preview for very large completed markdown", () => {
    const fullText = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
    const repeatedText = `${fullText}\n${"x".repeat(240_000)}`;
    const previewText = buildLargeMarkdownPreviewText(repeatedText);

    expect(previewText).toContain("large response collapsed for faster rendering");
    expect(previewText.length).toBeLessThan(repeatedText.length);
  });
});
