import { expect, test } from "vitest";
import { MarkitLineHighlighter, type NativeHighlighter } from "./highlighter.ts";

/*
 * markit's shared worker can restart and forget every highlighter it held. The editor's
 * highlighter then makes a new one from the document's text, so colours come back.
 */

function engine() {
  const made: { texts: string[]; dead: boolean }[] = [];
  const create = (): NativeHighlighter => {
    const state = { texts: [] as string[], dead: false };
    made.push(state);
    const alive = () => {
      if (state.dead) throw new Error("Closed line highlighter");
    };
    return {
      setText: async (text) => {
        alive();
        state.texts.push(text);
      },
      edit: async () => alive(),
      tokens: async (start, end) => {
        alive();
        const text = state.texts.at(-1) ?? "";
        return text
          .split("\n")
          .slice(start, end)
          .map((line) => [{ text: line, light: "#111111", dark: "#eeeeee" }]);
      },
      advance: async () => false,
      free: () => {},
    };
  };
  return { made, create };
}

function painted(highlighter: MarkitLineHighlighter) {
  return new Promise<void>((resolve) => {
    const stop = highlighter.subscribe(() => {
      stop();
      resolve();
    });
  });
}

test("colours come back after the engine forgets the highlighter", async () => {
  const fake = engine();
  let text = "const a = 1;\nconst b = 2;";
  const highlighter = new MarkitLineHighlighter("ts", { delay: 0, create: fake.create });
  highlighter.follow(() => text);
  highlighter.tokens(0, 2);
  await painted(highlighter);
  expect(highlighter.tokens(0, 2)[0]?.[0]?.light).toBe("#111111");

  // The worker restarts: the old highlighter is gone, and the text has moved on meanwhile.
  const first = fake.made[0];
  if (first) first.dead = true;
  text = "let c = 3;\nconst b = 2;";
  highlighter.edit(0, 1, ["let c = 3;"]);
  await painted(highlighter);

  expect(fake.made).toHaveLength(2);
  expect(fake.made[1]?.texts).toEqual([text]);
  expect(highlighter.tokens(0, 2)[0]?.[0]?.text).toBe("let c = 3;");
  highlighter.dispose();
});

test("an engine that keeps failing is left alone after a few rebuilds", async () => {
  const made: number[] = [];
  const create = (): NativeHighlighter => {
    made.push(made.length);
    const fail = async () => {
      throw new Error("Closed line highlighter");
    };
    return { setText: fail, edit: fail, tokens: fail, advance: fail, free: () => {} };
  };
  const highlighter = new MarkitLineHighlighter("ts", { delay: 0, create });
  highlighter.follow(() => "x");
  highlighter.tokens(0, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(made.length).toBeLessThanOrEqual(4);
  highlighter.dispose();
});
