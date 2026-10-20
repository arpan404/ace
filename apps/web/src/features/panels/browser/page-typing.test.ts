import { describe, expect, it } from "vitest";
import type { ForwardedInput } from "../sources.ts";
import { editInput, keyboardKind, typedEdit, typedLocally } from "./page-typing.ts";

/** What a page's field holds after the forwarded input, typed at its caret (at the end). */
function typeInto(text: string, inputs: readonly ForwardedInput[]): string {
  let points = [...text];
  for (const input of inputs) {
    if (input.kind !== "key") continue;
    if (input.event === "char") points.push(...(input.text ?? ""));
    else if (input.event === "keyDown" && input.key === "Backspace") points = points.slice(0, -1);
    else if (input.event === "keyDown" && input.key === "Enter") points.push("\n");
  }
  return points.join("");
}
/** The page's field after the local field went from `before` to `after`, carets at the end. */
const replay = (page: string, before: string, after: string) =>
  typeInto(page, editInput(typedEdit(before, before.length, after, after.length)));

describe("typing through the local field", () => {
  it("types a keystroke as text at the page's caret", () => {
    expect(replay("Dear ", "", "h")).toBe("Dear h");
  });

  it("lands autocorrect's replacement of the word behind the caret exactly", () => {
    expect(replay("helo ", "helo ", "hello ")).toBe("hello ");
    expect(replay("I'm teh ", "teh ", "the ")).toBe("I'm the ");
  });

  it("lands a swipe-typed word and accented letters as typed", () => {
    expect(replay("", "", "héllo wörld")).toBe("héllo wörld");
  });

  it("deletes a whole emoji with one Backspace", () => {
    const edit = typedEdit("ok 👍", 5, "ok ", 3);
    expect(edit).toEqual({ backspaces: 1, deletes: 0, text: "" });
    expect(replay("ok 👍", "ok 👍", "ok ")).toBe("ok ");
  });

  it("sends a typed line break as Enter, so forms submit as they would", () => {
    const inputs = editInput(typedEdit("", 0, "hi\n", 3));
    expect(inputs.filter((input) => input.kind === "key" && input.key === "Enter")).toEqual([
      { kind: "key", event: "keyDown", key: "Enter", code: "Enter", text: "\r" },
      { kind: "key", event: "keyUp", key: "Enter", code: "Enter" },
    ]);
  });

  it("deletes forward when text after the caret goes", () => {
    expect(typedEdit("abcd", 2, "abd", 2)).toEqual({ backspaces: 0, deletes: 1, text: "" });
  });

  it("splits long text into pieces the wire takes", () => {
    const pieces = editInput({ backspaces: 0, deletes: 0, text: "x".repeat(600) });
    expect(pieces.map((input) => (input.kind === "key" ? input.text?.length : 0))).toEqual([
      256, 256, 88,
    ]);
  });
});

const key = (value: string, extra: Partial<Parameters<typeof typedLocally>[0]> = {}) => ({
  key: value,
  keyCode: 0,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});
describe("which keys the local field types", () => {
  it("types what an IME or a dead key composes, on any keyboard", () => {
    expect(typedLocally(key("a", { isComposing: true }), false)).toBe(true);
    expect(typedLocally(key("Process", { keyCode: 229 }), false)).toBe(true);
    expect(typedLocally(key("Dead"), false)).toBe(true);
  });
  it("leaves plain letters to key events on a hardware keyboard, and types them on a phone", () => {
    expect(typedLocally(key("a"), false)).toBe(false);
    expect(typedLocally(key("a"), true)).toBe(true);
  });
  it("never types Enter, Backspace, arrows or shortcuts", () => {
    for (const named of ["Enter", "Backspace", "Tab", "ArrowLeft"])
      expect(typedLocally(key(named), true)).toBe(false);
    expect(typedLocally(key("c", { metaKey: true }), true)).toBe(false);
  });
});

describe("the phone keyboard for the page's field", () => {
  const rect = { x: 0, y: 0, width: 100, height: 20 };
  it("matches the field's type", () => {
    expect(keyboardKind({ type: "email", rect }).inputMode).toBe("email");
    expect(keyboardKind({ type: "url", rect }).inputMode).toBe("url");
    expect(keyboardKind({ type: "tel", rect }).inputMode).toBe("tel");
    expect(keyboardKind({ type: "number", rect }).inputMode).toBe("decimal");
    expect(keyboardKind({ type: "search", rect })).toMatchObject({
      inputMode: "search",
      enterKeyHint: "search",
    });
    expect(keyboardKind({ type: "textarea", rect }).inputMode).toBe("text");
  });
  it("turns autocorrect off for passwords", () => {
    expect(keyboardKind({ type: "password", rect }).assisted).toBe(false);
    expect(keyboardKind({ type: "text", rect }).assisted).toBe(true);
  });
  it("follows the page's own inputmode and enterkeyhint, ignoring ones it doesn't know", () => {
    expect(
      keyboardKind({ type: "text", rect, inputMode: "numeric", enterKeyHint: "send" }),
    ).toMatchObject({ inputMode: "numeric", enterKeyHint: "send" });
    expect(keyboardKind({ type: "email", rect, inputMode: "banana" }).inputMode).toBe("email");
  });
});
