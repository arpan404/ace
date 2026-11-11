import { decorateComposerText, type ComposerToken } from "@ace/ui-core";
import { afterEach, expect, test } from "vitest";
import { editorText, placeEditorCaret } from "./editor-dom.ts";
import { editorSignature, renderEditor } from "./editor-render.ts";
import { editorInSync } from "./editor-sync.ts";

/*
 * The editor is drawn from the text's Markdown and left alone while what it shows still matches,
 * so typing keeps the browser's caret and IME; anything else draws it again.
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
  document.body.append(el);
  renderEditor(el, decorateComposerText(text, tokens), text, tokens);
  return el;
}
const inSync = (el: HTMLElement, text: string, tokens: readonly ComposerToken[] = []) =>
  editorInSync(editorSignature(el), decorateComposerText(text, tokens), text, tokens);
/** Type into the text node holding `words`, as the browser would. */
function typeInto(el: HTMLElement, words: string, next: string) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.textContent === words) return void (node.textContent = next);
  throw new Error(`No text node "${words}"`);
}

test("a drawn editor reads back its exact Markdown", () => {
  const text = "# Plan\n- **milk** and @a.ts\n  1. eggs\n";
  const el = drawn(text, [chip(22, "@a.ts")]);
  expect(editorText(el)).toBe(text);
  expect(inSync(el, text, [chip(22, "@a.ts")])).toBe(true);
  expect(el.querySelector('[data-md="h1"]')?.textContent).toBe("# Plan");
  expect(el.querySelector('[data-md="bold"]')?.textContent).toBe("**milk**");
  expect(el.querySelector('[data-md="number"]')?.getAttribute("data-depth")).toBe("2");
});

test.each([
  ["typing inside bold words", "a **bold** b", "bold", "bolder", "a **bolder** b", true],
  ["typing in a heading", "# Plan", "Plan", "Plans", "# Plans", true],
  ["typing in a list item's words", "- milk", " milk", " milks", "- milks", true],
  ["a line that just became a heading", "#Plan", "#Plan", "# Plan", "# Plan", false],
  ["words that just became bold", "**a*", "**a*", "**a**", "**a**", false],
])(
  "%s redraws the editor only when its drawing changes: %s",
  (_name, before, words, next, text, kept) => {
    const el = drawn(before);
    typeInto(el, words, next);
    expect(editorText(el)).toBe(text);
    expect(inSync(el, text)).toBe(kept);
  },
);

test("words typed into bold words' closing marks draw the editor again", () => {
  const el = drawn("**a**");
  const closing = el.querySelectorAll('[data-md="mark"]')[1]?.firstChild;
  if (!closing) throw new Error("No closing marks");
  closing.textContent = "** b";
  expect(editorText(el)).toBe("**a** b");
  expect(inSync(el, "**a** b")).toBe(false);
});

test("typing beside a chip leaves the editor alone even though the chip's offsets moved", () => {
  const el = drawn("see @a.ts", [chip(4, "@a.ts")]);
  typeInto(el, "see ", "now see ");
  expect(inSync(el, "now see @a.ts", [chip(8, "@a.ts")])).toBe(true);
});

test("a chip added or taken away draws the editor again", () => {
  const text = "see @a.ts";
  expect(inSync(drawn(text), text, [chip(4, "@a.ts")])).toBe(false);
  expect(inSync(drawn(text, [chip(4, "@a.ts")]), text)).toBe(false);
});

test("formatting the browser adds on its own draws the editor again", () => {
  const el = drawn("plain");
  const bold = document.createElement("b");
  bold.append(document.createTextNode("x"));
  el.append(bold);
  expect(inSync(el, "plainx")).toBe(false);
});

test("a caret at the end of bold words types plain words after them", () => {
  const el = drawn("**bold** after");
  el.focus();
  placeEditorCaret(el, 8);
  const focus = document.getSelection()?.focusNode;
  expect(focus?.textContent).toBe(" after");
  expect(focus?.parentElement?.closest('[data-md="bold"]')).toBeNull();
});

test("a caret at the end of a heading stays in the heading", () => {
  const el = drawn("# Plan\nnext");
  el.focus();
  placeEditorCaret(el, 6);
  expect(
    document.getSelection()?.focusNode?.parentElement?.closest('[data-md="h1"]'),
  ).not.toBeNull();
});
