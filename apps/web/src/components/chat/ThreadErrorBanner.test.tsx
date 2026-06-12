import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("anchors actions in the right-side grid column", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Runtime failed" onDismiss={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );

    expect(markup).toContain("fixed");
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(markup).toContain('data-thread-error-banner-actions=""');
    expect(markup).toContain("col-start-3");
    expect(markup).toContain("Dismiss error");
  });
});
