import { describe, expect, test } from "vitest";
import {
  composerBlocks,
  offsetPoint,
  pointOffset,
  serializeBlocks,
  type ComposerBlock,
} from "./composer-blocks.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/** What the person sees: each line's style, then its words, bold in `<b>`, chips in `[]`. */
function seen(blocks: readonly ComposerBlock[]): string {
  return blocks
    .map((block) => {
      const style = block.style;
      const tag =
        style.kind === "heading"
          ? `h${style.level}`
          : style.kind === "item"
            ? `item${style.depth}`
            : style.kind;
      const words = block.runs
        .map((run) => {
          const face = run.type === "chip" ? `[${run.token?.label ?? run.text}]` : run.text;
          return run.bold ? `<b>${face}</b>` : face;
        })
        .join("");
      return `${tag}:${words}`;
    })
    .join("\n");
}

const chip = (start: number, label: string): ComposerToken => ({
  start,
  end: start + label.length,
  label,
  file: { path: label.slice(1) },
});

describe("what the person sees of the Markdown", () => {
  test.each([
    ["plain words", "just words", "plain:just words"],
    ["bold words without their marks", "**a. ahhas**", "plain:<b>a. ahhas</b>"],
    ["a heading without its marks", "## Plan it", "h2:Plan it"],
    ["bold in a heading", "# **Big** day", "h1:<b>Big</b> day"],
    ["a bullet's words without its dash", "- milk", "item1:milk"],
    ["a star bullet, which isn't bold", "* milk", "item1:milk"],
    ["a numbered item's words", "1. milk", "item1:milk"],
    ["nested items by level", "- a\n  - b", "item1:a\nitem2:b"],
    ["an empty item", "- ", "item1:"],
    ["stars that aren't bold, as typed", "a ** b ****", "plain:a ** b ****"],
    ["fenced code exactly as typed", "```\n# **x**\n```", "code:```\ncode:# **x**\ncode:```"],
  ])("%s", (_name, text, expected) => {
    expect(seen(composerBlocks(text, []))).toBe(expected);
  });

  test("a chip stands in its words, bold with them", () => {
    expect(seen(composerBlocks("see **@a.ts**", [chip(6, "@a.ts")]))).toBe(
      "plain:see <b>[@a.ts]</b>",
    );
  });
});

describe("written back as Markdown", () => {
  test.each([
    "just words",
    "**a. ahhas**",
    "## Plan **it** now",
    "- a\n  - **b**\n1. c\n   3) d",
    "a ** b ****",
    "```\n# **x**\n```",
    "",
    "line\n\nafter a blank\n",
  ])("%j reads back exactly", (text) => {
    expect(serializeBlocks(composerBlocks(text, [])).text).toBe(text);
  });

  test("chips keep their tokens at their new places", () => {
    const text = "# **@a.ts** x";
    const written = serializeBlocks(composerBlocks(text, [chip(4, "@a.ts")]));
    expect(written.text).toBe(text);
    expect(written.tokens).toEqual([chip(4, "@a.ts")]);
  });

  test.each([
    [
      "spaces at the edges of bold words go outside the marks",
      [{ type: "text" as const, text: " word ", bold: true }],
      " **word** ",
    ],
    [
      "neighbouring bold runs share one pair of marks",
      [
        { type: "text" as const, text: "ab", bold: true },
        { type: "text" as const, text: "cd", bold: true },
      ],
      "**abcd**",
    ],
    [
      "bold that is only spaces is plain",
      [{ type: "text" as const, text: "  ", bold: true }],
      "  ",
    ],
  ])("%s", (_name, runs, expected) => {
    expect(serializeBlocks([{ style: { kind: "plain" }, runs }]).text).toBe(expected);
  });
});

/** `|` in the Markdown marks an offset; the result marks the visible point the same way. */
function shown(marked: string): string {
  const offset = marked.indexOf("|");
  const text = marked.replace("|", "");
  const blocks = composerBlocks(text, []);
  const written = serializeBlocks(blocks);
  const point = offsetPoint(blocks, written, offset);
  // Back in Markdown, where that visible point is written.
  const back = pointOffset(written, point);
  return `${text.slice(0, back)}|${text.slice(back)}`;
}
describe("caret places", () => {
  test.each([
    ["in words, where it is", "ab|c", "ab|c"],
    ["in a heading's marks, at its words", "#| Plan", "# |Plan"],
    ["in a bullet's marker, at its words", "-| milk", "- |milk"],
    ["before bold words' opening marks, after the plain words", "a |**b**", "a |**b**"],
    ["in opening marks, at the bold words", "a *|*b**", "a **|b**"],
    ["after closing marks, at the end of the bold words", "**b**| c", "**b|** c"],
    ["in closing marks, at the end of the bold words", "**b*|* c", "**b|** c"],
    ["at a line's end after bold", "**b**|", "**b|**"],
    ["on an empty item", "- a\n- |", "- a\n- |"],
    ["on the second line", "a\n# |b", "a\n# |b"],
  ])("%s", (_name, marked, expected) => {
    expect(shown(marked)).toBe(expected);
  });
});
