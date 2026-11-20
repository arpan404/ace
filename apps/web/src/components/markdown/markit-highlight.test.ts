import { MarkitRenderer } from "@ace/markit-web/react";
import { describe, expect, it, vi } from "vitest";
import { markitCodeLines } from "./markit-highlight.ts";

// A chat code block must never pull the grammar Wasm; importing it would run this factory.
const grammarImported = vi.hoisted(() => vi.fn());
vi.mock("@markit/web/pkg-grammars/markit_wasm.js", () => {
  grammarImported();
  return { default: async () => undefined, initSync: () => undefined };
});

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

describe("chat code highlighting stays on the core engine", () => {
  it("never loads the grammar Wasm when grammar is off", async () => {
    const renderer = new MarkitRenderer(document.createElement("div"), { worker: "inline" });
    const result = await renderer.highlight("const answer = 42;", "tsx", { grammar: false });
    renderer.destroy();

    expect(result.plain).toBe(false);
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(grammarImported).not.toHaveBeenCalled();
  });
});
