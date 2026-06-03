import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    expect(html).toContain("Working tree changes");
    expect(html).toContain("+15");
    expect(html).toContain("-19");
    expect(html).toContain("changes across");
    expect(html).toContain("files");
    expect(html).toContain('aria-label="Regenerate summary"');
    expect(html).not.toContain(">Changes<");
    expect(html).not.toContain(">Files<");
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

  it("renders todos without generated status labels", () => {
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

    expect(html).toContain("Create todo doc");
    expect(html).toContain("Wire persistence");
    expect(html).not.toContain(">In progress<");
    expect(html).not.toContain(">Ready<");
    expect(html).not.toContain(">Done<");
  });

  it("renders seeded demo content when summary demo mode is enabled", () => {
    vi.stubGlobal("window", {
      location: {
        search: "?summaryDemo=full",
      },
    });

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

    expect(html).toContain("Summary panel demo");
    expect(html).toContain("Summary side panel redesign");
    expect(html).toContain("Wire demo data across summary, plan, todos, and diff");
    expect(html).toContain("changes across");
  });

  it("renders seeded demo content from the shared environment demo switch", () => {
    vi.stubGlobal("window", {
      location: {
        search: "?environmentDemo=full",
      },
    });

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

    expect(html).toContain("Summary panel demo");
    expect(html).toContain("Summary side panel redesign");
  });
});
