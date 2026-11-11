import { afterEach, expect, test } from "vitest";
import {
  editorCaret,
  editorChips,
  editorText,
  insertEditorText,
  placeEditorCaret,
} from "./editor-dom.ts";

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

test("each chip's offset is where its text starts in the editor's words", () => {
  const el = document.createElement("div");
  el.contentEditable = "true";
  const chip = (text: string) => {
    const node = document.createElement("span");
    node.dataset.tokenText = text;
    return node;
  };
  const bold = document.createElement("span");
  bold.dataset.md = "bold";
  bold.append("**a ", chip("@x.ts"), "**");
  const line = document.createElement("div");
  line.append("next ", chip("￼"));
  el.append("see ", bold, document.createElement("br"), line);
  document.body.append(el);
  const text = editorText(el);
  const chips = editorChips(el);
  expect(chips.map((found) => found.start)).toEqual([8, 22]);
  expect(chips.map((found) => text.slice(found.start, found.start + 1))).toEqual(["@", "￼"]);
});
