import type { GitStatusResult, ThreadId } from "@ace/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActiveGoalState, ActivePlanState } from "../../session-logic";
import type { EnvironmentMiniPanel as EnvironmentMiniPanelType } from "./EnvironmentMiniPanel";
import type { SubagentThread } from "./subagentThreads";

let EnvironmentMiniPanel: typeof EnvironmentMiniPanelType;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  });
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
        toggle: vi.fn(),
      },
    },
  });
  ({ EnvironmentMiniPanel } = await import("./EnvironmentMiniPanel"));
});

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

const activeGoal: ActiveGoalState = {
  createdAt: "2026-06-03T00:00:01.000Z",
  threadId: "provider-thread-1",
  objective: "Implement provider feature parity without polluting the transcript",
  status: "active",
  tokenBudget: 1000,
  tokensUsed: 120,
};

function subagentThread(overrides: Partial<SubagentThread> = {}): SubagentThread {
  return {
    id: "child-provider-thread-1",
    label: "Dewey",
    persona: {
      avatarClassName: "bg-sky-500/14 text-sky-500 ring-sky-500/24",
      haloClassName: "bg-sky-500/14",
      initials: "DE",
      name: "Dewey",
      pingClassName: "bg-sky-400",
    },
    roleLabel: "Explorer",
    status: "completed",
    entries: [
      {
        id: "subagent-message",
        createdAt: "2026-06-02T00:00:00.000Z",
        label: "Subagent message",
        tone: "thinking",
        subagentId: "child-provider-thread-1",
        subagentName: "Dewey",
      },
    ],
    ...overrides,
  };
}

function renderEnvironmentMiniPanel(
  overrides: Partial<ComponentProps<typeof EnvironmentMiniPanel>> = {},
) {
  return renderToStaticMarkup(
    <EnvironmentMiniPanel
      activeProjectScripts={undefined}
      activeGoal={null}
      activePlan={null}
      activeSubagentThreadId={null}
      activeThreadId={"thread-1" as ThreadId}
      branchToolbarProps={null}
      editorStateInstanceId="test-workspace-editor"
      gitCwd={null}
      gitStatus={null}
      gitStatusError={null}
      branchList={null}
      isGitRepo={false}
      keybindings={[]}
      layoutMode="inline"
      onAddProjectScript={() => Promise.resolve()}
      onDeleteGoal={() => undefined}
      onDeleteProjectScript={() => Promise.resolve()}
      onEditGoal={() => undefined}
      onOpenDiffPanel={() => undefined}
      onOpenEnvironmentSettings={() => undefined}
      onJumpToMessage={() => undefined}
      onOpenSummaryPanel={() => undefined}
      onRunProjectScript={() => undefined}
      onPauseGoal={() => undefined}
      onResumeGoal={() => undefined}
      onSelectSubagentThread={() => undefined}
      onSubagentPanelOpen={() => undefined}
      onUpdateProjectScript={() => Promise.resolve()}
      onWorkspaceModeChange={() => undefined}
      preferredScriptId={null}
      subagentThreads={[]}
      workspaceChangeStat={null}
      workspaceMode="chat"
      {...overrides}
    />,
  );
}

describe("EnvironmentMiniPanel", () => {
  it("renders active todo progress with loading and completed states", () => {
    const markup = renderEnvironmentMiniPanel({ activePlan });

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
          activeGoal={null}
          activePlan={null}
          activeSubagentThreadId={null}
          activeThreadId={"thread-1" as ThreadId}
          branchToolbarProps={null}
          editorStateInstanceId="test-workspace-editor"
          gitCwd="/repo"
          gitStatus={cleanGitStatus}
          gitStatusError={null}
          branchList={null}
          isGitRepo={true}
          keybindings={[]}
          layoutMode="inline"
          onAddProjectScript={() => Promise.resolve()}
          onDeleteGoal={() => undefined}
          onDeleteProjectScript={() => Promise.resolve()}
          onEditGoal={() => undefined}
          onOpenDiffPanel={() => undefined}
          onOpenEnvironmentSettings={() => undefined}
          onJumpToMessage={() => undefined}
          onOpenSummaryPanel={() => undefined}
          onRunProjectScript={() => undefined}
          onPauseGoal={() => undefined}
          onResumeGoal={() => undefined}
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

  it("shows completed subagent conversations by name only in the environment card", () => {
    const markup = renderEnvironmentMiniPanel({ subagentThreads: [subagentThread()] });

    expect(markup).toContain("Subagents");
    expect(markup).toContain("Dewey");
    expect(markup).toContain("[image-rendering:pixelated]");
    expect(markup).not.toContain("lucide-smile");
    expect(markup).not.toContain("Explorer");
    expect(markup).not.toContain("Completed");
  });

  it("shows side chats as a separate environment card group", () => {
    const markup = renderEnvironmentMiniPanel({
      subagentThreads: [
        subagentThread(),
        subagentThread({
          id: "side:thread-1:first",
          label: "Explain the current branch.",
          entries: [
            {
              id: "side-chat-one",
              createdAt: "2026-06-02T00:00:01.000Z",
              label: "User message",
              tone: "thinking",
              subagentId: "side:thread-1:first",
              subagentType: "side chat",
              sideChatMessageRole: "user",
              sideChatMessageText: "Explain the current branch.",
            },
          ],
        }),
        subagentThread({
          id: "side:thread-1:second",
          label: "Check the recent diff.",
          entries: [
            {
              id: "side-chat-two",
              createdAt: "2026-06-02T00:00:02.000Z",
              label: "User message",
              tone: "thinking",
              subagentId: "side:thread-1:second",
              subagentType: "side chat",
              sideChatMessageRole: "user",
              sideChatMessageText: "Check the recent diff.",
            },
          ],
        }),
      ],
    });

    expect(markup).toContain("Side chats");
    expect(markup).toContain("Subagents");
    expect(markup).toContain("Explain the current branch.");
    expect(markup).toContain("Check the recent diff.");
    expect(markup).toContain("Dewey");
  });

  it("renders active goals separately from progress and environment state", () => {
    const markup = renderEnvironmentMiniPanel({ activeGoal });

    expect(markup).toContain("Goal");
    expect(markup).toContain("Implement provider feature parity");
    expect(markup).toContain("120 / 1,000 tokens");
    expect(markup).toContain("Pause goal");
    expect(markup).toContain("Edit goal");
    expect(markup).toContain("Delete goal");
  });
});
