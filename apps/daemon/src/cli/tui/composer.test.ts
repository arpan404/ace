import { describe, expect, it } from "vitest";
import { decodeKeys } from "./keys.ts";
import { composerKey, composerView, emptyComposer, type Composer, type ComposerResult } from "./composer.ts";

function type(input: string, from: Composer = emptyComposer): ComposerResult[] {
  const results: ComposerResult[] = [];
  let composer = from;
  for (const key of decodeKeys(input)) {
    const result = composerKey(composer, key);
    results.push(result);
    composer = result.composer;
  }
  return results;
}

describe("the composer", () => {
  it("sends the typed text on Enter and empties itself", () => {
    const last = type("fix it\r").at(-1);
    expect(last).toEqual({ kind: "submit", text: "fix it", composer: emptyComposer });
  });

  it("adds a line with Alt+Enter instead of sending", () => {
    const results = type("one\x1b\rtwo\r");
    expect(results.at(-1)).toMatchObject({ kind: "submit", text: "one\ntwo" });
  });

  it("turns a trailing backslash into a new line, as a shell does", () => {
    const results = type("one\\\rtwo\r");
    expect(results.at(-1)).toMatchObject({ kind: "submit", text: "one\ntwo" });
  });

  it("asks for the editor on Ctrl-G", () => {
    expect(type("draft\x07").at(-1)?.kind).toBe("editor");
  });

  it("keeps a pasted block's newlines without sending it", () => {
    const results = type("\x1b[200~a\nb\x1b[201~");
    expect(results.at(-1)).toMatchObject({ kind: "edit", composer: { text: "a\nb" } });
  });

  it("deletes a whole emoji with one backspace", () => {
    expect(type("ok😀\x7f").at(-1)?.composer.text).toBe("ok");
  });

  it("places the cursor after wide text in the drawn line", () => {
    const view = composerView({ text: "日本", cursor: 2 }, 40);
    expect(view.lines).toEqual(["› 日本"]);
    expect(view.cursor).toEqual({ row: 0, column: 6 });
  });
});
