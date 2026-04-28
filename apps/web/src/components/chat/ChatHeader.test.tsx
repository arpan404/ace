import { ThreadId, type ResolvedKeybindingsConfig } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActivePlanProgressState } from "../../session-logic";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  it("shows active todo progress instead of workspace diff counts", () => {
    const activePlanProgress: ActivePlanProgressState = {
      total: 5,
      completed: 1,
      currentIndex: 2,
      currentStep: "Implement summary integration",
      currentStatus: "inProgress",
    };
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadId={ThreadId.makeUnsafe("thread-1")}
        activeThreadTitle="Summary"
        activeProjectId={null}
        activeProjectName={undefined}
        isGitRepo
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[] satisfies ResolvedKeybindingsConfig}
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        rightSidePanelToggleShortcutLabel={null}
        gitCwd={null}
        activePlanProgress={activePlanProgress}
        isAgentWorking
        workspaceChangeStat={{ additions: 12, deletions: 4 }}
        rightSidePanelOpen={false}
        workspaceMode="chat"
        onRunProjectScript={() => undefined}
        onAddProjectScript={async () => undefined}
        onUpdateProjectScript={async () => undefined}
        onDeleteProjectScript={async () => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
        onWorkspaceModeChange={() => undefined}
      />,
    );

    expect(markup).toContain("02/05");
    expect(markup).not.toContain("Workspace changes: 12 additions, 4 deletions");
  });

  it("hides active todo progress when the agent is idle", () => {
    const activePlanProgress: ActivePlanProgressState = {
      total: 5,
      completed: 1,
      currentIndex: 2,
      currentStep: "Implement summary integration",
      currentStatus: "inProgress",
    };
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadId={ThreadId.makeUnsafe("thread-1")}
        activeThreadTitle="Summary"
        activeProjectId={null}
        activeProjectName={undefined}
        isGitRepo
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[] satisfies ResolvedKeybindingsConfig}
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        rightSidePanelToggleShortcutLabel={null}
        gitCwd={null}
        activePlanProgress={activePlanProgress}
        isAgentWorking={false}
        workspaceChangeStat={{ additions: 12, deletions: 4 }}
        rightSidePanelOpen={false}
        workspaceMode="chat"
        onRunProjectScript={() => undefined}
        onAddProjectScript={async () => undefined}
        onUpdateProjectScript={async () => undefined}
        onDeleteProjectScript={async () => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
        onWorkspaceModeChange={() => undefined}
      />,
    );

    expect(markup).not.toContain("02/05");
    expect(markup).toContain("Workspace changes: 12 additions, 4 deletions");
  });
});
