import { describe, expect, it } from "vitest";
import { contextEntries, type ContextFacts } from "./context-entries.ts";

const page: ContextFacts = {
  linkURL: "",
  srcURL: "",
  mediaType: "none",
  hasImageContents: false,
  selectionText: "",
  isEditable: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canGoBack: true,
  canGoForward: false,
};

/** The menu as the person reads it: labels, `—` for separators, `(off)` for disabled rows. */
const menu = (facts: Partial<ContextFacts>) =>
  contextEntries({ ...page, ...facts }).map((entry) =>
    entry === "separator" ? "—" : entry.enabled ? entry.label : `${entry.label} (off)`,
  );

describe("the native page's context menu", () => {
  it("on the page itself offers history, ace's annotate, page source and Inspect", () => {
    expect(menu({})).toEqual([
      "Back",
      "Forward (off)",
      "Reload",
      "—",
      "Annotate this element",
      "—",
      "View page source",
      "Inspect",
    ]);
  });

  it("on a link offers opening and copying it instead of history", () => {
    expect(menu({ linkURL: "https://example.com/a" }).slice(0, 3)).toEqual([
      "Open link in new tab",
      "Copy link address",
      "—",
    ]);
    expect(menu({ linkURL: "mailto:a@example.com" })[0]).toBe("Open link in new tab (off)");
    expect(menu({ linkURL: "https://example.com/a" })).not.toContain("Back");
  });

  it("on an image offers copying and saving it", () => {
    expect(
      menu({
        mediaType: "image",
        srcURL: "https://example.com/a.png",
        hasImageContents: true,
      }).slice(0, 3),
    ).toEqual(["Copy image", "Copy image address", "Save image as…"]);
  });

  it("in a field offers cut, copy and paste as the field allows", () => {
    expect(menu({ isEditable: true, canPaste: true }).slice(0, 3)).toEqual([
      "Cut (off)",
      "Copy (off)",
      "Paste",
    ]);
  });

  it("on selected text offers Copy", () => {
    expect(menu({ selectionText: "hello", canCopy: true })[0]).toBe("Copy");
  });
});
