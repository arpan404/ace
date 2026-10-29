import { describe, expect, it } from "vitest";
import { markitCodeLines } from "./markit-highlight.ts";

describe("markit highlight tokens become ace code lines", () => {
  it("splits tokens at newlines keeping both theme colors", () => {
    const doc = markitCodeLines(
      {
        language: "ts",
        plain: false,
        tokens: [
          { text: "const a = 1;\n", light: "#111111", dark: "#eeeeee" },
          { text: "const b = 2;", light: "#222222", dark: "#dddddd" },
        ],
      },
      "hash",
    );
    if (!("lines" in doc)) throw new Error("Expected highlighted lines");
    expect(doc.lines).toEqual([
      [{ kind: "plain", text: "const a = 1;", light: "#111111", dark: "#eeeeee" }],
      [{ kind: "plain", text: "const b = 2;", light: "#222222", dark: "#dddddd" }],
    ]);
  });

  it("a markit plain fallback stays plain without lines", () => {
    expect(markitCodeLines({ language: "txt", plain: true, tokens: [] }, "hash")).toEqual({
      hash: "hash",
      plain: true,
    });
  });

  it("an oversized token graph stays plain instead of crossing the reply budget", () => {
    const tokens = Array.from({ length: 200_000 }, (_, index) => ({
      text: `t${index}\n`,
      light: "#111111",
      dark: "#eeeeee",
    }));
    expect(markitCodeLines({ language: "ts", plain: false, tokens }, "hash")).toEqual({
      hash: "hash",
      plain: true,
    });
  });
});
