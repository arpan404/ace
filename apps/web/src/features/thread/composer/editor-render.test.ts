import { composerBlocks, type ComposerToken } from "@ace/ui-core";
import { afterEach, expect, test } from "vitest";
import { editorCaret, editorText, placeEditorCaret } from "./editor-dom.ts";
import { editorShows, renderEditor } from "./editor-render.ts";

/*
 * The editor shows what the person sees and never the Markdown that writes it, yet reads back
 * the exact Markdown, with the caret in Markdown offsets. It is left alone while it still shows
 * the text's blocks, so typing keeps the browser's caret and IME; anything else draws it again.
 */

afterEach(() => document.body.replaceChildren());

const chip = (start: number, label: string): ComposerToken => ({
  start,
  end: start + label.length,
  label,
  file: { path: label.slice(1) },
});

function drawn(text: string, tokens: readonly ComposerToken[] = []): HTMLElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.style.whiteSpace = "pre-wrap";
  document.body.append(el);
  renderEditor(el, composerBlocks(text, tokens));
  return el;
}
const shows = (el: HTMLElement, text: string, tokens: readonly ComposerToken[] = []) =>
  editorShows(el, composerBlocks(text, tokens));
function textNode(el: HTMLElement, words: string): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent === words && node instanceof Text) return node;
  throw new Error(`No text "${words}"`);
}

const text = "# Plan\n- **milk** and @a.ts\n  1. eggs\n```\n**raw**\n```";
const tokens = [chip(22, "@a.ts")];

test("the editor shows no Markdown syntax, yet reads back the exact Markdown", () => {
  const el = drawn(text, tokens);
  const lines = [...el.children].map((line) => line.textContent);
  // The chip's slot is empty until React fills it.
  expect(lines).toEqual(["Plan", "milk and ", "eggs", "```", "**raw**", "```"]);
  expect(el.querySelector("strong")?.textContent).toBe("milk");
  expect(el.querySelector('[data-md="h1"]')?.textContent).toBe("Plan");
  expect(el.querySelector('[data-md="item"][data-depth="2"]')?.getAttribute("data-glyph")).toBe(
    "1.",
  );
  expect(editorText(el)).toBe(text);
  expect(shows(el, text, tokens)).toBe(true);
});

test("a caret after bold words sits at their end, inside the bold, and reads back the same", () => {
  const el = drawn("**bold** after");
  el.focus();
  placeEditorCaret(el, 8);
  const focus = document.getSelection()?.focusNode;
  expect(focus?.parentElement?.closest("strong")?.textContent).toBe("bold");
  expect(editorCaret(el)).toBe(6);
});

test("a caret in a heading's hidden marks goes to its words", () => {
  const el = drawn("## Plan");
  el.focus();
  placeEditorCaret(el, 1);
  expect(editorCaret(el)).toBe(3);
});

test.each([
  ["typing inside bold words", "a **bold** b", "bold", "bolder", "a **bolder** b", true],
  ["typing in a heading", "# Plan", "Plan", "Plans", "# Plans", true],
  ["typing in a list item", "- milk", "milk", "milks", "- milks", true],
  ["a line that just became a heading", "#Plan", "#Plan", "# Plan", "# Plan", false],
  ["words that just became bold", "**a*", "**a*", "**a**", "**a**", false],
])("%s: the editor is %s", (_name, before, words, next, after, kept) => {
  const el = drawn(before);
  textNode(el, words).textContent = next;
  expect(editorText(el)).toBe(after);
  expect(shows(el, after)).toBe(kept);
});

test("a heading's words joined onto the line before read as that line's words", () => {
  const el = drawn("first\n## second");
  const [first, second] = [...el.children];
  if (!first || !second) throw new Error("Two lines expected");
  // What the browser does on Backspace at the start of the heading.
  first.append(...second.childNodes);
  second.remove();
  expect(editorText(el)).toBe("firstsecond");
});

test("pasted line breaks read as lines of their own, and draw the editor again", () => {
  const el = drawn("ab");
  textNode(el, "ab").textContent = "a\n- b";
  expect(editorText(el)).toBe("a\n- b");
  expect(shows(el, "a\n- b")).toBe(false);
});

test("formatting the browser adds on its own draws the editor again", () => {
  const el = drawn("plain");
  const bold = document.createElement("b");
  bold.append("x");
  el.firstElementChild?.append(bold);
  expect(editorText(el)).toBe("plain**x**");
  expect(shows(el, "plain**x**")).toBe(false);
});
