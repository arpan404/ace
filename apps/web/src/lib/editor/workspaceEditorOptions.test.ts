import { describe, expect, it } from "vitest";

import { createWorkspaceEditorOptions } from "./workspaceEditorOptions";

describe("createWorkspaceEditorOptions", () => {
  it("creates a compact workspace editor option snapshot", () => {
    const options = createWorkspaceEditorOptions({
      lineNumbers: "on",
      minimap: true,
      renderWhitespace: false,
      stickyScroll: true,
      suggestions: true,
      wordWrap: false,
    });

    expect(options).toMatchObject({
      fontSize: 13,
      lineHeight: 22,
      lineNumbers: "on",
      renderWhitespace: false,
      suggestions: true,
      tabSize: 2,
      wordWrap: false,
    });
  });

  it("preserves user-facing editor toggles for CodeMirror extensions", () => {
    const options = createWorkspaceEditorOptions({
      lineNumbers: "relative",
      minimap: false,
      renderWhitespace: true,
      stickyScroll: false,
      suggestions: false,
      wordWrap: true,
    });

    expect(options.lineNumbers).toBe("relative");
    expect(options.renderWhitespace).toBe(true);
    expect(options.suggestions).toBe(false);
    expect(options.wordWrap).toBe(true);
  });
});
