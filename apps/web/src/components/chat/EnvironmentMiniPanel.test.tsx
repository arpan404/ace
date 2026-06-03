import type { ThreadId } from "@ace/contracts";
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
  it("renders active todo progress with loading and completed strike-through states", () => {
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
});
