import { afterEach, expect, test } from "vitest";
import { editorCaret, editorText, insertEditorText, placeEditorCaret } from "./editor-dom.ts";

function editor(text: string, caret: number): HTMLElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.append(document.createTextNode(text));
  document.body.append(el);
  el.focus();
  placeEditorCaret(el, caret);
  return el;
}

afterEach(() => document.body.replaceChildren());

test("pasting text that ends in a newline at the end of the draft draws the caret's new empty line", () => {
  const el = editor("Hello", 5);
  insertEditorText(el, " there\n");
  expect(editorText(el)).toBe("Hello there\n");
  expect(editorCaret(el)).toBe(12);
  // A final newline alone draws no line; the break after it is the line the caret sits on.
  expect(el.lastChild?.nodeName).toBe("BR");
});

test("pasting a newline mid-draft leaves the text after it to carry the line", () => {
  const el = editor("Hello world", 5);
  insertEditorText(el, "\n");
  expect(editorText(el)).toBe("Hello\n world");
  expect(editorCaret(el)).toBe(6);
  expect(el.querySelector("br")).toBeNull();
});
