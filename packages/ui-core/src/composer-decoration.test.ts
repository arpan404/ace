import { expect, test } from "vitest";
import { decorateComposerText, type DecorationNode } from "./composer-decoration.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/** A drawing as nested words: `<bold><mark>**</mark>hi<mark>**</mark></bold>`, chips as `[…]`. */
function drawn(text: string, tokens: readonly ComposerToken[] = []): string {
  const show = (nodes: readonly DecorationNode[]): string =>
    nodes
      .map((node) => {
        if (node.type === "text") return text.slice(node.start, node.end);
        if (node.type === "token") return `[${tokens[node.index]?.label ?? ""}]`;
        const name = `${node.kind}${node.depth ?? ""}`;
        return `<${name}>${show(node.children)}</${name}>`;
      })
      .join("");
  return show(decorateComposerText(text, tokens));
}

test.each([
  ["plain words as they are", "just words", "just words"],
  ["a heading at its level", "## Plan", "<h2><mark>## </mark>Plan</h2>"],
  ["no heading without its space", "#hashtag", "#hashtag"],
  ["no fourth heading level", "#### deep", "#### deep"],
  ["bold words with their marks", "a **b** c", "a <bold><mark>**</mark>b<mark>**</mark></bold> c"],
  ["no bold with spaces inside its marks", "a ** b ** c", "a ** b ** c"],
  ["no bold from empty marks", "****", "****"],
  ["no bold across lines", "**a\nb**", "**a\nb**"],
  [
    "bold in a heading",
    "# **Big**",
    "<h1><mark># </mark><bold><mark>**</mark>Big<mark>**</mark></bold></h1>",
  ],
  ["a bullet", "- milk", "<bullet1>-</bullet1> milk"],
  ["a star bullet, which isn't bold", "* milk", "<bullet1>*</bullet1> milk"],
  ["a number", "1. milk", "<number1>1.</number1> milk"],
  [
    "nested items by level",
    "- a\n  - b\n    - c",
    "<bullet1>-</bullet1> a\n<indent>  </indent><bullet2>-</bullet2> b\n<indent>    </indent><bullet3>-</bullet3> c",
  ],
  ["a dash without its space is words", "-milk", "-milk"],
  [
    "nothing inside fenced code",
    "```\n# a\n- b **c**\n```\n# d",
    "```\n# a\n- b **c**\n```\n<h1><mark># </mark>d</h1>",
  ],
])("draws %s", (_name, text, expected) => {
  expect(drawn(text)).toBe(expected);
});

test("chips sit inside the styles around them, and their text never styles", () => {
  const tokens: ComposerToken[] = [
    { start: 4, end: 11, label: "@a**.ts", file: { path: "a**.ts" } },
    { start: 14, end: 15, label: "shot.png", attachment: { key: 1 } },
  ];
  expect(drawn("# **@a**.ts** \uFFFC", tokens)).toBe(
    "<h1><mark># </mark><bold><mark>**</mark>[@a**.ts]<mark>**</mark></bold> [shot.png]</h1>",
  );
});
