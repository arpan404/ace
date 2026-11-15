import { expect, it } from "vitest";
import { questionFate, type QuestionFacts } from "./child-question.ts";

/*
 * Whether the person's open question about a child on another machine still stands (ADR 0153):
 * one the child's state no longer explains is closed, so no parent is ever held by a question
 * nobody can answer.
 */

const child = (facts: Partial<QuestionFacts>): QuestionFacts => ({
  settled: false,
  unpaired: false,
  watching: false,
  stopping: false,
  silent: false,
  ...facts,
});

const table: [string, "keep" | "close", Partial<QuestionFacts>][] = [
  ["working and in contact again", "close", {}],
  ["lost contact", "keep", { silent: true }],
  ["lost contact, then a Stop began", "close", { silent: true, stopping: true }],
  ["being stopped", "close", { stopping: true }],
  ["its machine unpaired", "keep", { unpaired: true }],
  ["its machine unpaired while lost contact", "keep", { unpaired: true, silent: true }],
  ["its machine unpaired while being stopped", "keep", { unpaired: true, stopping: true }],
  ["settled", "close", { settled: true }],
  ["settled after losing contact", "close", { settled: true, silent: true }],
  [
    "settled and watched, its machine unpaired",
    "keep",
    { settled: true, unpaired: true, watching: true },
  ],
  ["abandoned: the person stopped tracking it", "close", { settled: true, unpaired: true }],
];

it.each(table)("a question about a child %s: %s", (_name, fate, facts) => {
  expect(questionFate(child(facts))).toBe(fate);
});
