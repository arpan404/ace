import { expect, test } from "vitest";
import { pick, withoutRepeats } from "./faq-topics.ts";

const a = { question: "A?", answer: "a" };
const b = { question: "B?", answer: "b" };
const c = { question: "C?", answer: "c" };

test("picking questions keeps the order asked for", () => {
  expect(pick([a, b, c], ["C?", "A?"])).toEqual([c, a]);
});

test("picking a question that no list holds fails, so a renamed question can't vanish quietly", () => {
  expect(() => pick([a], ["Z?"])).toThrow(/Z\?/);
});

test("a question asked under two topics stays only under the first", () => {
  const topics = withoutRepeats([
    { id: "one", questions: [a, b] },
    { id: "two", questions: [b, c, c] },
  ]);
  expect(topics.map((topic) => topic.questions.map((entry) => entry.question))).toEqual([
    ["A?", "B?"],
    ["C?"],
  ]);
  expect(topics[1]?.id).toBe("two");
});
