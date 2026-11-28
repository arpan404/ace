import { expect, it } from "vitest";
import { AgentId, ItemId, type Item, type Question } from "@ace/protocol";
import {
  canContinue,
  canResolveInteraction,
  clearClosedResolution,
  clearResolutionSending,
  completeAnswers,
  currentQuestionIndex,
  dismissedResolution,
  emptyQuestionDraft,
  isResolutionLocked,
  isUnanswerable,
  markResolutionRefused,
  markResolutionSending,
  markResolutionSent,
  mayAct,
  questionResolution,
  refusalMessage,
  resolutionEntry,
  setOtherText,
  shellCommandForApproval,
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

it("fails closed when act permission is unknown", () => {
  expect(mayAct(undefined)).toBe(false);
  expect(mayAct(false)).toBe(false);
  expect(mayAct(true)).toBe(true);
  expect(canResolveInteraction("pending", false, mayAct(undefined))).toBe(false);
  expect(canResolveInteraction("pending", false, mayAct(true))).toBe(true);
});

it("names daemon refusals instead of inviting a retry", () => {
  expect(refusalMessage("already_resolved", "This approval could not be answered")).toBe(
    "Already answered on another device.",
  );
  expect(refusalMessage("not_found", "These questions could not be answered")).toBe(
    "This request no longer exists.",
  );
  expect(refusalMessage("bogus-code", "This approval could not be answered")).toBe(
    "This approval could not be answered",
  );
  expect(refusalMessage(undefined, "These questions could not be answered")).toBe(
    "These questions could not be answered",
  );
});

function toolItem(
  detail: { kind: "shell"; command: string } | { kind: "file.read"; path: string },
  kind: "shell" | "file.read" = "shell",
): Item {
  return {
    id: ItemId.parse("tool-1"),
    agentId: AgentId.parse("agent-1"),
    createdAt: 0,
    complete: true,
    type: "tool_call",
    call: {
      id: ItemId.parse("tool-1"),
      agentId: AgentId.parse("agent-1"),
      kind,
      title: "Run it",
      status: "running",
      detail,
      startedAt: 0,
      raw: [],
    },
  };
}

it("reads the shell step's command behind an approval", () => {
  expect(shellCommandForApproval(toolItem({ kind: "shell", command: "bun install" }))).toBe(
    "bun install",
  );
  expect(
    shellCommandForApproval(toolItem({ kind: "file.read", path: "src/a.ts" }, "file.read")),
  ).toBeUndefined();
  expect(shellCommandForApproval(undefined)).toBeUndefined();
});

it("locks an interaction across remounts until its answer settles", () => {
  const id = "fix-review-lock-sending";
  expect(isResolutionLocked(id)).toBe(false);
  markResolutionSending(id);
  expect(isResolutionLocked(id)).toBe(true);
  expect(resolutionEntry(id)?.phase).toBe("sending");
  expect(canResolveInteraction("pending", isResolutionLocked(id), true)).toBe(false);
  markResolutionSending(id);
  expect(resolutionEntry(id)?.phase).toBe("sending");
  // Transport failure: the daemon never saw it, so the pending card may retry.
  clearResolutionSending(id);
  expect(isResolutionLocked(id)).toBe(false);
  expect(canResolveInteraction("pending", isResolutionLocked(id), true)).toBe(true);
});

it("a daemon refusal stays shut instead of retrying", () => {
  const id = "fix-review-lock-refused";
  markResolutionSending(id);
  markResolutionRefused(id, "Already answered on another device.");
  expect(isResolutionLocked(id)).toBe(true);
  expect(resolutionEntry(id)?.message).toBe("Already answered on another device.");
  // Refusals never clear as retryable: the daemon's no is final.
  clearResolutionSending(id);
  expect(isResolutionLocked(id)).toBe(true);
  expect(canResolveInteraction("pending", isResolutionLocked(id), true)).toBe(false);
});

it("an accepted answer stays shut while a closed card drops stale locks", () => {
  const id = "fix-review-lock-sent";
  markResolutionSending(id);
  markResolutionSent(id);
  clearResolutionSending(id);
  expect(isResolutionLocked(id)).toBe(true);
  clearClosedResolution(id);
  expect(isResolutionLocked(id)).toBe(true);

  const stale = "fix-review-lock-stale";
  markResolutionSending(stale);
  clearClosedResolution(stale);
  expect(isResolutionLocked(stale)).toBe(false);

  const refused = "fix-review-lock-stale-refused";
  markResolutionRefused(refused, "Already answered on another device.");
  clearClosedResolution(refused);
  expect(isResolutionLocked(refused)).toBe(false);
});
