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
  it("renders workspace summary as a toggleable section header", () => {
    const html = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={null}
        activeProposedPlan={null}
        generatedWorkspaceSummary={{
          createdAt: "2026-05-05T00:00:00.000Z",
          turnId: null,
          headline: "Updated workspace summary",
          summary: "Refined the summary surface.",
          keyChanges: ["Switched summary rendering to markdown"],
          risks: [],
          markdown: "### Updated workspace summary\n\nRefined the summary surface.",
        }}
        activeProvider="codex"
        markdownCwd={undefined}
        workspaceDiffSummary={null}
        workspaceRoot={undefined}
      />,
    );

    expect(html).toContain("Summary");
    expect(html).toContain("Updated workspace summary");
    expect(html).toContain('aria-expanded="true"');
  });

  it("renders diff metadata inside the workspace summary section when both are available", () => {
    const html = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={null}
        activeProposedPlan={null}
        generatedWorkspaceSummary={{
          createdAt: "2026-05-05T00:00:00.000Z",
          turnId: null,
          headline: "Updated workspace summary",
          summary: "Refined the summary surface.",
          keyChanges: ["Switched summary rendering to markdown"],
          risks: [],
          markdown: "### Updated workspace summary\n\nRefined the summary surface.",
        }}
        activeProvider="codex"
        markdownCwd={undefined}
        onRegenerateSummary={() => undefined}
        workspaceDiffSummary={{ additions: 15, deletions: 19, fileCount: 2 }}
        workspaceRoot={undefined}
      />,
    );

    expect(html).toContain("Diff summary");
    expect(html).toContain("Current diff:");
    expect(html).toContain('aria-label="Regenerate summary"');
    expect(html).not.toContain(">Changes<");
  });

  it("does not render summary placeholder copy when no summary or diff is available", () => {
    const html = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={null}
        activeProposedPlan={null}
        generatedWorkspaceSummary={null}
        activeProvider="codex"
        markdownCwd={undefined}
        workspaceDiffSummary={null}
        workspaceRoot={undefined}
      />,
    );

    expect(html).not.toContain("No current workspace diff is available.");
    expect(html).not.toContain("Diff summary");
    expect(html).not.toContain("No changes");
  });

  it("renders a no changes state when summary generation is available but there is no diff", () => {
    const html = renderToStaticMarkup(
      <PlanSummaryPanel
        activePlan={null}
        activeProposedPlan={null}
        generatedWorkspaceSummary={null}
        activeProvider="codex"
        markdownCwd={undefined}
        onRegenerateSummary={() => undefined}
        workspaceDiffSummary={null}
        workspaceRoot={undefined}
      />,
    );

    expect(html).toContain(">Changes<");
    expect(html).toContain("No changes");
    expect(html).toContain("There are no uncommitted code changes.");
    expect(html).toContain('aria-label="Generate summary"');
  });

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
        generatedWorkspaceSummary={null}
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
