import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerPendingComments } from "./ComposerPendingComments";

describe("ComposerPendingComments", () => {
  it("renders compact pending comment rows with clear and dismiss actions", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingComments
        comments={[
          {
            id: "comment-1",
            sourceLabel: "Browser",
            targetLabel: "/settings/browser",
            body: "Tighten this control group.",
            previewUrl: "data:image/png;base64,abc",
          },
        ]}
        onDismiss={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    expect(markup).toContain("Pending comments");
    expect(markup).toContain("/settings/browser");
    expect(markup).toContain("Tighten this control group.");
    expect(markup).toContain('aria-label="Clear pending comments"');
    expect(markup).toContain('aria-label="Remove pending comment"');
  });

  it("renders nothing when there are no pending comments", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingComments comments={[]} onDismiss={vi.fn()} onClearAll={vi.fn()} />,
    );

    expect(markup).toBe("");
  });
});
