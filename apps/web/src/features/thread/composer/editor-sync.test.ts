import type { ComposerToken } from "@ace/ui-core";
import { expect, test } from "vitest";
import { editorInSync } from "./editor-sync.ts";

const chip = (start: number, label: string): ComposerToken => ({
  start,
  end: start + label.length,
  label,
});

test("typing beside a chip leaves the editor alone even though the chip's offsets moved", () => {
  const text = "see @a.ts now";
  expect(editorInSync({ text, tokens: ["@a.ts"] }, text, [chip(4, "@a.ts")])).toBe(true);
});

test("text changed from outside, or a chip added or removed, rebuilds the editor", () => {
  expect(editorInSync({ text: "draft", tokens: [] }, "recalled", [])).toBe(false);
  const text = "see @a.ts";
  expect(editorInSync({ text, tokens: [] }, text, [chip(4, "@a.ts")])).toBe(false);
  expect(editorInSync({ text, tokens: ["@a.ts"] }, text, [])).toBe(false);
});
