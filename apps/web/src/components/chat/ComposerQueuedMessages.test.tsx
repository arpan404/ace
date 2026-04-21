import { MessageId } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { appendBrowserDesignContextToPrompt } from "../../lib/terminalContext";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";

describe("ComposerQueuedMessages", () => {
  it("renders the refined queue surface with steering and attachment metadata", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-1"),
            prompt: "Refine the layout spacing across the header and sidebar.",
            images: [{ id: "image-1" }, { id: "image-2" }],
            terminalContexts: [{ id: "terminal-1" }],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        steerMessageId={MessageId.makeUnsafe("queued-1")}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain("Pending");
    expect(markup).toContain("Steering");
    expect(markup).toContain("2 images");
    expect(markup).toContain("1 terminal");
    expect(markup).toContain('aria-label="Steering queued message"');
  });

  it("keeps designer comments delete-only in the queue", () => {
    const prompt = appendBrowserDesignContextToPrompt("Tighten the card rhythm", {
      requestId: "DR-4F2C8A11",
      pageUrl: "https://example.com/dashboard",
      pagePath: "/dashboard",
      selection: { x: 24, y: 40, width: 360, height: 180 },
      targetElement: null,
      mainContainer: null,
    });

    const markup = renderToStaticMarkup(
      <ComposerQueuedMessages
        messages={[
          {
            id: MessageId.makeUnsafe("queued-design"),
            prompt,
            images: [],
            terminalContexts: [],
            modelSelection: { provider: "codex", model: "gpt-5.4" },
          },
        ]}
        steerMessageId={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={vi.fn()}
        onSteer={vi.fn()}
      />,
    );

    expect(markup).toContain("Comment");
    expect(markup).not.toContain("Edit queued message");
  });
});
