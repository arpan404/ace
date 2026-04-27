import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ActivePlanState, LatestProposedPlanState } from "../session-logic";
import { PlanSummaryPanel } from "./PlanSummaryPanel";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "dark" as const,
    resolvedTheme: "dark" as const,
    setTheme: () => undefined,
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
}));

describe("PlanSummaryPanel", () => {
  it("renders the proposed plan and live todo state inside the summary surface", () => {
    const activePlan: ActivePlanState = {
      createdAt: "2026-04-27T10:00:00.000Z",
      turnId: null,
      source: "plan-update",
      explanation: "Keep the implementation thread focused on the summary tab.",
      steps: [
        { step: "Ship embedded summary content", status: "inProgress" },
        { step: "Remove the dedicated plan sidebar", status: "completed" },
      ],
    };
    const activeProposedPlan: LatestProposedPlanState = {
      id: "plan-1",
      createdAt: "2026-04-27T09:58:00.000Z",
      updatedAt: "2026-04-27T10:00:00.000Z",
      turnId: null,
      planMarkdown: "## Proposed plan\n\n- Audit summary surface\n- Embed plan and todo details",
      implementedAt: null,
      implementationThreadId: null,
    };

    const markup = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={activePlan}
        activeProposedPlan={activeProposedPlan}
        activeProvider="githubCopilot"
        markdownCwd={undefined}
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Plan");
    expect(markup).toContain("Todos");
    expect(markup).toContain("plan.md");
    expect(markup).toContain("Live todo state");
    expect(markup).toContain("Audit summary surface");
    expect(markup).toContain("Ship embedded summary content");
    expect(markup).toContain("1/2 done");
  });
});
