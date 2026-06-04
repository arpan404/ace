import type { GitStatusResult, ThreadId } from "@ace/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActivePlanState } from "../../session-logic";
import { EnvironmentMiniPanel } from "./EnvironmentMiniPanel";

const activePlan: ActivePlanState = {
  createdAt: "2026-06-03T00:00:00.000Z",
  source: "plan-update",
  turnId: null,
  steps: [
    { step: "Map repository surfaces", status: "completed" },
    { step: "Inspect critical paths locally", status: "inProgress" },
    { step: "Run quality gates", status: "pending" },
  ],
};

describe("EnvironmentMiniPanel", () => {
  it("renders active todo progress with loading and completed states", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentMiniPanel
        activeProjectScripts={undefined}
        activePlan={activePlan}
        activeSubagentThreadId={null}
        activeThreadId={"thread-1" as ThreadId}
        branchToolbarProps={null}
        gitCwd={null}
        gitStatus={null}
        gitStatusError={null}
        branchList={null}
        isGitRepo={false}
        keybindings={[]}
        layoutMode="inline"
        onAddProjectScript={() => Promise.resolve()}
        onDeleteProjectScript={() => Promise.resolve()}
        onOpenDiffPanel={() => undefined}
        onOpenEnvironmentSettings={() => undefined}
        onJumpToMessage={() => undefined}
        onOpenSummaryPanel={() => undefined}
        onRunProjectScript={() => undefined}
        onSelectSubagentThread={() => undefined}
        onSubagentPanelOpen={() => undefined}
        onUpdateProjectScript={() => Promise.resolve()}
        onWorkspaceModeChange={() => undefined}
        preferredScriptId={null}
        subagentThreads={[]}
        workspaceChangeStat={null}
        workspaceMode="chat"
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Inspect critical paths locally");
    expect(markup).toContain("Map repository surfaces");
    expect(markup).not.toContain("line-through");
    expect(markup).toContain("lucide-check");
  });

  it("renders clean changes state after git status loads with no working tree changes", () => {
    const queryClient = new QueryClient();
    const cleanGitStatus: GitStatusResult = {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EnvironmentMiniPanel
          activeProjectScripts={undefined}
          activePlan={null}
          activeSubagentThreadId={null}
          activeThreadId={"thread-1" as ThreadId}
          branchToolbarProps={null}
          gitCwd="/repo"
          gitStatus={cleanGitStatus}
          gitStatusError={null}
          branchList={null}
          isGitRepo={true}
          keybindings={[]}
          layoutMode="inline"
          onAddProjectScript={() => Promise.resolve()}
          onDeleteProjectScript={() => Promise.resolve()}
          onOpenDiffPanel={() => undefined}
          onOpenEnvironmentSettings={() => undefined}
          onJumpToMessage={() => undefined}
          onOpenSummaryPanel={() => undefined}
          onRunProjectScript={() => undefined}
          onSelectSubagentThread={() => undefined}
          onSubagentPanelOpen={() => undefined}
          onUpdateProjectScript={() => Promise.resolve()}
          onWorkspaceModeChange={() => undefined}
          preferredScriptId={null}
          subagentThreads={[]}
          workspaceChangeStat={null}
          workspaceMode="chat"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain(">Clean<");
    expect(markup).not.toContain("Checking changes");
  });
});
