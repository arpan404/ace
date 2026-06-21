import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Keep current envelope",
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Scaffold only",
      }),
    ).toBe("Scaffold only");
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabel: "Preserve existing tags",
          selectedOptionLabels: ["Preserve existing tags", "Drop legacy tags"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      selectedOptionLabel: undefined,
      selectedOptionLabels: undefined,
      customAnswer: "doesn't matter",
    });
  });
});

describe("selectPendingUserInputOption", () => {
  const multiSelectQuestion = {
    id: "tools",
    header: "Tools",
    question: "Which tools should run?",
    multiSelect: true,
    options: [
      {
        label: "Search",
        description: "Run search",
      },
      {
        label: "Edit",
        description: "Run edits",
      },
    ],
  } as const;

  it("toggles multi-select options in question order", () => {
    const onceSelected = selectPendingUserInputOption(multiSelectQuestion, undefined, "Search");
    expect(onceSelected).toEqual({
      selectedOptionLabels: ["Search"],
      customAnswer: "",
    });

    const twiceSelected = selectPendingUserInputOption(multiSelectQuestion, onceSelected, "Edit");
    expect(twiceSelected).toEqual({
      selectedOptionLabels: ["Search", "Edit"],
      customAnswer: "",
    });

    expect(selectPendingUserInputOption(multiSelectQuestion, twiceSelected, "Search")).toEqual({
      selectedOptionLabels: ["Edit"],
      customAnswer: "",
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });

  it("returns array answers for complete multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "tools",
            header: "Tools",
            question: "Which tools should run?",
            multiSelect: true,
            options: [
              {
                label: "Search",
                description: "Run search",
              },
              {
                label: "Edit",
                description: "Run edits",
              },
            ],
          },
        ],
        {
          tools: {
            selectedOptionLabels: ["Search", "Edit"],
          },
        },
      ),
    ).toEqual({
      tools: ["Search", "Edit"],
    });
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabel: "Orchestration-first",
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("derives multi-select progress from selected option arrays", () => {
    const question = {
      id: "tools",
      header: "Tools",
      question: "Which tools should run?",
      multiSelect: true,
      options: [
        {
          label: "Search",
          description: "Run search",
        },
        {
          label: "Edit",
          description: "Run edits",
        },
      ],
    } as const;

    expect(
      derivePendingUserInputProgress(
        [question],
        {
          tools: {
            selectedOptionLabels: ["Search", "Edit"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: question,
      selectedOptionLabels: ["Search", "Edit"],
      customAnswer: "",
      resolvedAnswer: ["Search", "Edit"],
      answeredQuestionCount: 1,
      isLastQuestion: true,
      isComplete: true,
      canAdvance: true,
    });
  });
});
