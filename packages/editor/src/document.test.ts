import { beforeAll, describe, expect, it } from "vitest";
import { EditorDocument } from "./document.ts";
import { initForTests } from "./test-support.ts";
import { isEditorError, type Selection } from "./types.ts";

beforeAll(initForTests);

/** The rejection a call throws, checked for its shared code. */
function rejection(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (!isEditorError(error)) {
      throw error;
    }
    return { code: error.code, message: error.message };
  }
  throw new Error("the call was expected to throw");
}

function caret(line: number, column: number): Selection {
  return { anchor: { line, column }, head: { line, column } };
}

describe("EditorDocument", () => {
  it("types at three cursors and inserts at each", () => {
    const document = new EditorDocument("one\ntwo\nthree");
    document.setSelections([caret(0, 3), caret(1, 3), caret(2, 5)]);

    const applied = document.insertText("!");

    expect(document.text()).toBe("one!\ntwo!\nthree!");
    expect(document.selections()).toEqual([caret(0, 4), caret(1, 4), caret(2, 6)]);
    expect(applied.version).toBe(1);
    expect(applied.spans).toEqual([{ firstLine: 0, removedLines: 3, insertedLines: 3 }]);
  });

  it("undo restores the text and the selections", () => {
    const document = new EditorDocument("hello world");
    document.setSelections([{ anchor: { line: 0, column: 6 }, head: { line: 0, column: 11 } }]);
    document.insertText("there");
    document.commit();

    const undone = document.undo();

    expect(undone?.version).toBe(2);
    expect(document.text()).toBe("hello world");
    expect(document.selections()).toEqual([
      { anchor: { line: 0, column: 6 }, head: { line: 0, column: 11 } },
    ]);
    expect(document.undo()).toBeUndefined();
    expect(document.redo()).toBeDefined();
  });

  it("reports separate spans for far-apart cursors", () => {
    const document = new EditorDocument("a\n".repeat(100));

    const applied = document.apply([
      {
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
        text: "first",
      },
      {
        range: { start: { line: 99, column: 0 }, end: { line: 99, column: 0 } },
        text: "second",
      },
    ]);

    expect(applied.spans).toEqual([
      { firstLine: 0, removedLines: 1, insertedLines: 1 },
      { firstLine: 99, removedLines: 1, insertedLines: 1 },
    ]);
    expect(document.line(0)).toBe("firsta");
    expect(document.line(99)).toBe("seconda");
  });

  it("reads only the requested lines after an edit", () => {
    const document = new EditorDocument("alpha\nbeta\ngamma\ndelta");
    expect(document.lines(1, 3)).toEqual(["beta", "gamma"]);

    document.apply([
      {
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
        text: "BETA",
      },
    ]);

    expect(document.lines(0, 2)).toEqual(["alpha", "BETA"]);
    expect(document.lines(10, 20)).toEqual([]);
    expect(document.lenLines()).toBe(4);
  });

  it("throws an error code on an invalid edit", () => {
    const document = new EditorDocument("abcdef");

    const error = rejection(() =>
      document.apply([
        {
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 4 } },
          text: "x",
        },
        {
          range: { start: { line: 0, column: 2 }, end: { line: 0, column: 5 } },
          text: "y",
        },
      ]),
    );

    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(document.text()).toBe("abcdef");
  });
});
