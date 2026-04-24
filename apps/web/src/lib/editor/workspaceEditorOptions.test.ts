import { describe, expect, it } from "vitest";

import { createWorkspaceEditorOptions } from "./workspaceEditorOptions";

describe("createWorkspaceEditorOptions", () => {
  it("keeps hover and error widgets inside the editor viewport", () => {
    const options = createWorkspaceEditorOptions({
      lineNumbers: "on",
      minimap: true,
      renderWhitespace: false,
      stickyScroll: true,
      suggestions: true,
      wordWrap: false,
    });

    expect(options.allowOverflow).toBe(false);
    expect(options.fixedOverflowWidgets).toBe(false);
  });

  it("enables visible occurrence and selection highlighting", () => {
    const options = createWorkspaceEditorOptions({
      lineNumbers: "on",
      minimap: false,
      renderWhitespace: false,
      stickyScroll: false,
      suggestions: true,
      wordWrap: true,
    });

    expect(options.occurrencesHighlight).toBe("singleFile");
    expect(options.occurrencesHighlightDelay).toBe(150);
    expect(options.selectionHighlight).toBe(true);
    expect(options.selectionHighlightMultiline).toBe(true);
    expect(options.selectionHighlightMaxLength).toBe(200);
  });
});
