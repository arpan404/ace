import { describe, expect, it } from "vitest";

import { buildDiffPanelUnsafeCss } from "./diffPanelUnsafeCss";

describe("buildDiffPanelUnsafeCss", () => {
  it("disables sticky diff headers in sidebar mode", () => {
    const css = buildDiffPanelUnsafeCss("sidebar");

    expect(css).toContain("[data-diffs-header]");
    expect(css).toContain("position: relative !important;");
    expect(css).toContain("top: auto !important;");
    expect(css).not.toContain("position: sticky !important;");
  });

  it("keeps sticky diff headers outside the sidebar", () => {
    const css = buildDiffPanelUnsafeCss("inline");

    expect(css).toContain("[data-diffs-header]");
    expect(css).toContain("position: sticky !important;");
    expect(css).toContain("top: 0;");
  });
});
