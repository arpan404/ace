import { expect, test } from "vitest";
import { itemPatch, textEdit } from "./text-edit.ts";

/** What native holds after applying `edit` to `before`, as `ClientModel` does. */
const apply = (before: string, edit: { base: number; cut: number; append: string }) => {
  expect(before.length).toBe(edit.base);
  return before.slice(edit.cut) + edit.append;
};

test("a growing message is sent as only its new words", () => {
  const before = "The agent is writing";
  const after = `${before} a longer answer now`;
  const edit = textEdit(before, after);
  expect(edit).toEqual({ base: before.length, cut: 0, append: " a longer answer now" });
  expect(apply(before, edit!)).toBe(after);
});

test("a long message whose window slides drops its front and adds its end", () => {
  const whole = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
  const before = whole.slice(-8192);
  const after = `${whole} and more words`.slice(-8192);
  const edit = textEdit(before, after);
  expect(edit?.cut).toBeGreaterThan(0);
  expect(edit?.append.length).toBeLessThan(40);
  expect(apply(before, edit!)).toBe(after);
});

test("a rewritten text, or one that changed more than it kept, goes whole", () => {
  expect(textEdit("first draft of the answer", "an entirely different answer")).toBeUndefined();
  expect(textEdit("ab", "abcdefghij")).toBeUndefined();
  expect(textEdit("same", "same")).toBeUndefined();
});

test("an edit never splits a surrogate pair", () => {
  const before = `😀${"x".repeat(50)}`;
  // Sliding by one unit would leave half the emoji at the front.
  const after = `${"\ude00"}${"x".repeat(50)}y`;
  expect(textEdit(before, after)).toBeUndefined();
});

test("a thread item becomes a text edit only against what native confirmed", () => {
  const row = (text: string) => ({ id: "i", index: 3, complete: false, text });
  const before = "Streaming ".repeat(30);
  const patch = { type: "thread.item", id: "i", threadId: "t", epoch: 2, row: row(`${before}on`) };
  expect(itemPatch(patch, undefined)).toBe(patch);
  expect(
    itemPatch(patch, { type: "thread.item", id: "i", threadId: "t", row: row(before) }),
  ).toEqual({
    type: "thread.item.text",
    id: "i",
    threadId: "t",
    epoch: 2,
    row: { ...row(""), text: "" },
    base: before.length,
    cut: 0,
    append: "on",
  });
  const removal = { type: "thread.item", id: "i", threadId: "t", epoch: 2, row: null };
  expect(itemPatch(removal, { row: row(before) })).toBe(removal);
});
