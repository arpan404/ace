import { expect, it } from "vitest";
import type { Question } from "@ace/protocol";
import {
  canContinue,
  canResolveInteraction,
  completeAnswers,
  currentQuestionIndex,
  dismissedResolution,
  emptyQuestionDraft,
  isUnanswerable,
  questionResolution,
  setOtherText,
  togglePick,
  visibleQuestions,
} from "./interactions.ts";

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "q",
    text: "Pick one",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    multiSelect: false,
    allowOther: false,
    secret: false,
    ...overrides,
  };
}

it("only a pending card with no in-flight send and act permission may resolve", () => {
  expect(canResolveInteraction("pending", false, true)).toBe(true);
  expect(canResolveInteraction("resolved", false, true)).toBe(false);
  expect(canResolveInteraction("cancelled", false, true)).toBe(false);
  expect(canResolveInteraction("expired", false, true)).toBe(false);
  expect(canResolveInteraction("pending", true, true)).toBe(false);
  expect(canResolveInteraction("pending", false, false)).toBe(false);
});

it("keeps exact option ids when a daemon offers hundreds of approval actions", () => {
  const options = Array.from({ length: 300 }, (_, at) => ({
    id: `action-${at}`,
    label: `Action ${at}`,
    kind: "allow_once" as const,
  }));
  const ids = new Set(options.map((option) => option.id));
  expect(ids.size).toBe(300);
  expect(options[299]?.id).toBe("action-299");
});

it("single-select replaces the pick and clears free text", () => {
  const q = question({ allowOther: true });
  let draft = emptyQuestionDraft();
  draft = togglePick(draft, q, "a");
  expect(draft.picked[q.id]).toEqual(["a"]);
  draft = setOtherText(draft, q, "hello");
  expect(draft.texts[q.id]).toBe("hello");
  draft = togglePick(draft, q, "b");
  expect(draft.picked[q.id]).toEqual(["b"]);
  expect(draft.texts[q.id]).toBe("");
});

it("multi-select accumulates picks and keeps free text beside them", () => {
  const q = question({ id: "m", multiSelect: true, allowOther: true });
  let draft = emptyQuestionDraft();
  draft = togglePick(draft, q, "a");
  draft = togglePick(draft, q, "b");
  draft = setOtherText(draft, q, "extra");
  expect(draft.picked[q.id]).toContain("a");
  expect(draft.picked[q.id]).toContain("b");
  expect(completeAnswers([q], draft)).toEqual({ m: ["a", "b", "extra"] });
  draft = togglePick(draft, q, "a");
  expect(draft.picked[q.id]).not.toContain("a");
});

it("requires an answer before continuing and resolves only when every question is answered", () => {
  const first = question({ id: "one" });
  const second = question({ id: "two" });
  let draft = emptyQuestionDraft();
  expect(canContinue(first, draft)).toBe(false);
  expect(questionResolution([first, second], draft)).toBeUndefined();
  draft = togglePick(draft, first, "a");
  expect(canContinue(first, draft)).toBe(true);
  expect(questionResolution([first, second], draft)).toBeUndefined();
  draft = togglePick(draft, second, "b");
  expect(questionResolution([first, second], draft)).toEqual({
    kind: "question",
    answers: { one: ["a"], two: ["b"] },
  });
});

it("sends free text as words for an allow-other question", () => {
  const q = question({ allowOther: true });
  let draft = emptyQuestionDraft();
  draft = setOtherText(draft, q, "  custom  ");
  expect(completeAnswers([q], draft)).toEqual({ q: ["custom"] });
});

it("dismisses with an empty answer set", () => {
  expect(dismissedResolution()).toEqual({ kind: "question", answers: {}, dismissed: true });
});

it("bounds phone cards and marks oversized sets unanswerable", () => {
  const many = Array.from({ length: 9 }, (_, at) =>
    question({ id: `q${at}`, options: [{ id: "a", label: "A" }] }),
  );
  expect(isUnanswerable(many)).toBe(true);
  expect(visibleQuestions(many)).toHaveLength(8);
  const wide = [
    question({ options: Array.from({ length: 33 }, (_, at) => ({ id: `o${at}`, label: "O" })) }),
  ];
  expect(isUnanswerable(wide)).toBe(true);
  expect(visibleQuestions(wide)[0]?.options).toHaveLength(32);
  expect(visibleQuestions(wide)[0]?.options[31]?.id).toBe("o31");
  expect(isUnanswerable([question()])).toBe(false);
});

it("clamps the pager inside the visible questions", () => {
  expect(currentQuestionIndex(-1, 3)).toBe(0);
  expect(currentQuestionIndex(9, 3)).toBe(2);
  expect(currentQuestionIndex(1, 3)).toBe(1);
  expect(currentQuestionIndex(0, 0)).toBe(0);
});
