import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createChatMessageStreamingTextState } from "../lib/chat/messageText";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "dark" as const,
    resolvedTheme: "dark" as const,
    setTheme: () => undefined,
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders lightweight preserved text while streaming", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={"**bold**\n\n- item"} cwd={undefined} isStreaming />,
    );

    expect(markup).toContain('data-streaming-markdown="true"');
    expect(markup).toContain("**bold**");
    expect(markup).not.toContain("<strong>");
  });

  it("renders markdown after streaming completes", () => {
    const markup = renderToStaticMarkup(<ChatMarkdown text="**bold**" cwd={undefined} />);

    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).not.toContain('data-streaming-markdown="true"');
  });

  it("caps very large streaming responses to a preview window", () => {
    const fullText = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
    const streamingTextState = createChatMessageStreamingTextState(fullText);
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={streamingTextState.previewText}
        cwd={undefined}
        isStreaming
        streamingTextState={streamingTextState}
      />,
    );

    expect(markup).toContain('data-streaming-markdown="true"');
    expect(markup).toContain("Showing the latest");
    expect(markup).toContain("line 2500");
  });

  it("renders a collapsed preview for very large completed responses", () => {
    const text = `${Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n")}\n${"x".repeat(240_000)}`;
    const markup = renderToStaticMarkup(<ChatMarkdown text={text} cwd={undefined} />);

    expect(markup).toContain('data-large-markdown-preview="true"');
    expect(markup).toContain("Render full markdown");
    expect(markup).toContain("large response collapsed for faster rendering");
  });
});
