import { describe, expect, it } from "vitest";

import { summarizeActivePlan } from "./plans";

describe("summarizeActivePlan", () => {
  it("prefers the first in-progress step as the current todo", () => {
    expect(
      summarizeActivePlan({
        steps: [
          { step: "Create todo doc", status: "completed" },
          { step: "Wire persistence", status: "inProgress" },
          { step: "Add task graph", status: "pending" },
        ],
      }),
    ).toEqual({
      total: 3,
      completed: 1,
      currentIndex: 2,
      currentStep: "Wire persistence",
      currentStatus: "inProgress",
    });
  });

  it("falls back to the first pending step when nothing is in progress", () => {
    expect(
      summarizeActivePlan({
        steps: [
          { step: "Create todo doc", status: "completed" },
          { step: "Wire persistence", status: "pending" },
          { step: "Add task graph", status: "pending" },
        ],
      }),
    ).toEqual({
      total: 3,
      completed: 1,
      currentIndex: 2,
      currentStep: "Wire persistence",
      currentStatus: "pending",
    });
  });

  it("reports no current todo when every step is completed", () => {
    expect(
      summarizeActivePlan({
        steps: [
          { step: "Create todo doc", status: "completed" },
          { step: "Wire persistence", status: "completed" },
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 2,
      currentIndex: null,
      currentStep: null,
      currentStatus: null,
    });
  });
});
