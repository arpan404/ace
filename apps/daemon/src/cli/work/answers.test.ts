import { describe, expect, test } from "vitest";
import { Interaction, InteractionResolution } from "@ace/protocol";
import { CliFailure } from "../output.ts";
import { allowResolution, answerResolution, denyResolution } from "./answers.ts";
import { snoozeUntil } from "./snooze.ts";

const at = 1_800_000_000_000;

function interaction(request: unknown, state = "pending"): Interaction {
  return Interaction.parse({
    id: "i_request1",
    threadId: "t_thread1",
    agentId: "root",
    blocking: true,
    state,
    createdAt: at,
    request,
  });
}

const approval = interaction({
  kind: "approval",
  title: "Run bun test",
  options: [
    { id: "once", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always" },
    { id: "no", label: "Deny", kind: "deny" },
  ],
});

const question = (questions: unknown[]) => interaction({ kind: "question", questions });
const pick = {
  id: "db",
  text: "Which database?",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sqlite", label: "SQLite" },
  ],
};

function failure(run: () => unknown): CliFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof CliFailure) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("allowing and denying a request", () => {
  test.each([
    { input: {}, option: "once" },
    { input: { always: true }, option: "always" },
    { input: { option: "always" }, option: "always" },
  ])("allow $input picks option $option", ({ input, option }) => {
    expect(allowResolution(approval, input)).toEqual({ kind: "approval", optionId: option });
  });

  test("deny picks the deny option", () => {
    expect(denyResolution(approval, {})).toEqual({ kind: "approval", optionId: "no" });
  });

  test("allowing with a deny option is a usage error listing the options", () => {
    const error = failure(() => allowResolution(approval, { option: "no" }));
    expect(error.outcome).toBe("usage");
    expect(error.detail.hint).toContain("once (Allow once)");
  });

  test("a plan is approved or sent back with feedback", () => {
    const plan = interaction({ kind: "plan_review", markdown: "1. Do it" });
    expect(allowResolution(plan, {})).toEqual({ kind: "plan_review", decision: "approve" });
    expect(denyResolution(plan, { feedback: "Smaller steps" })).toEqual({
      kind: "plan_review",
      decision: "reject",
      feedback: "Smaller steps",
    });
  });

  test("a question isn't allowed, it is answered", () => {
    const error = failure(() => allowResolution(question([pick]), {}));
    expect(error.outcome).toBe("usage");
    expect(error.detail.hint).toContain("ace request answer");
  });

  test("denying a question declines it", () => {
    expect(denyResolution(question([pick]), {})).toEqual({
      kind: "question",
      answers: {},
      dismissed: true,
    });
  });

  test("a closed request refuses any answer", () => {
    const closed = interaction(approval.request, "resolved");
    expect(failure(() => allowResolution(closed, {})).outcome).toBe("refused");
  });
});

describe("answering a question", () => {
  test.each([
    {
      name: "a choice by its id",
      questions: [pick],
      input: { choices: ["pg"] },
      answers: { db: ["pg"] },
    },
    {
      name: "a choice for one of several questions",
      questions: [pick, { ...pick, id: "cache", text: "Cache?" }],
      input: { choices: ["db=sqlite", "cache=pg"] },
      answers: { db: ["sqlite"], cache: ["pg"] },
    },
    {
      name: "typed text where the question allows its own answer",
      questions: [{ ...pick, allowOther: true }],
      input: { text: "MySQL", choices: [] },
      answers: { db: ["MySQL"] },
    },
    {
      name: "typed text for a question with no choices",
      questions: [{ id: "name", text: "Its name?", options: [] }],
      input: { text: "upload-fix", choices: [] },
      answers: { name: ["upload-fix"] },
    },
    {
      name: "several choices where it takes many",
      questions: [{ ...pick, multiSelect: true }],
      input: { choices: ["pg", "sqlite"] },
      answers: { db: ["pg", "sqlite"] },
    },
  ])("$name", ({ questions, input, answers }) => {
    const resolution = answerResolution(question(questions), input);
    expect(InteractionResolution.parse(resolution)).toEqual({ kind: "question", answers });
  });

  test.each([
    { name: "no answer at all", input: { choices: [] }, argument: "--choice" },
    { name: "a choice it doesn't offer", input: { choices: ["mongo"] }, argument: "--choice" },
    {
      name: "two choices where it takes one",
      input: { choices: ["pg", "sqlite"] },
      argument: "--choice",
    },
  ])("$name is a usage error naming $argument", ({ input, argument }) => {
    const error = failure(() => answerResolution(question([pick]), input));
    expect(error.outcome).toBe("usage");
    expect(error.detail.argument).toBe(argument);
  });

  test("an approval isn't answered, it is allowed or denied", () => {
    expect(failure(() => answerResolution(approval, { choices: [] })).detail.hint).toContain(
      "ace request allow",
    );
  });
});

describe("snoozing until", () => {
  const monday9 = new Date(2026, 10, 16, 9, 0, 0, 0).getTime();
  const sundayNoon = new Date(2026, 10, 15, 12, 0, 0, 0).getTime();
  test.each([
    { value: "1h", until: sundayNoon + 3_600_000 },
    { value: "30m", until: sundayNoon + 1_800_000 },
    { value: "tomorrow", until: monday9 },
    { value: "monday", until: monday9 },
  ])("$value wakes at its time", ({ value, until }) => {
    expect(snoozeUntil(value, sundayNoon)).toEqual({ until });
  });

  test("an event snooze still wakes after thirty days", () => {
    expect(snoozeUntil("needs-you", sundayNoon)).toEqual({
      until: sundayNoon + 30 * 86_400_000,
      wake: "needs_you",
    });
    expect(snoozeUntil("pr-changes", sundayNoon).wake).toBe("pr");
  });

  test("anything else is a usage error naming --until", () => {
    expect(failure(() => snoozeUntil("someday", sundayNoon)).detail.argument).toBe("--until");
  });
});
