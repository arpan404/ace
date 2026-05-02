import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  it("renders only one active in-progress todo when multiple rows are marked in progress", () => {
    const html = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={{
          createdAt: "2026-04-28T12:00:00.000Z",
          turnId: null,
          source: "plan-update",
          steps: [
            { step: "Create todo doc", status: "inProgress" },
            { step: "Wire persistence", status: "inProgress" },
            { step: "Add task graph", status: "pending" },
          ],
        }}
        activeProposedPlan={null}
        activeProvider="codex"
        markdownCwd={undefined}
        workspaceDiffSummary={null}
        workspaceRoot={undefined}
      />,
    );

    expect(html).toContain(">In progress<");
    expect(html.match(/>In progress</g)?.length ?? 0).toBe(1);
    expect(html).not.toContain(">Ready<");
  });
});
