import { ThreadId } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { SubagentThread } from "./subagentThreads";
import type { EnvironmentMiniPanel as EnvironmentMiniPanelType } from "./EnvironmentMiniPanel";

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

describe("EnvironmentMiniPanel", () => {
  it("shows completed subagent conversations in the environment card", () => {
    const html = renderToStaticMarkup(
      <EnvironmentMiniPanel
        activeProjectScripts={undefined}
        activePlanProgress={null}
        activeSubagentThreadId={null}
        activeThreadId={ThreadId.makeUnsafe("thread-1")}
        branchToolbarProps={null}
        gitCwd={null}
        isGitRepo={false}
        isAgentWorking={false}
        keybindings={[]}
        layoutMode="popover"
        onAddProjectScript={async () => undefined}
        onDeleteProjectScript={async () => undefined}
        onOpenDiffPanel={() => undefined}
        onOpenEnvironmentSettings={() => undefined}
        onOpenSummaryPanel={() => undefined}
        onRunProjectScript={() => undefined}
        onSelectSubagentThread={() => undefined}
        onSubagentPanelOpen={() => undefined}
        onUpdateProjectScript={async () => undefined}
        onWorkspaceModeChange={() => undefined}
        preferredScriptId={null}
        subagentThreads={[subagentThread()]}
        workspaceChangeStat={null}
        workspaceMode="chat"
      />,
    );

    expect(html).toContain("Subagents");
    expect(html).toContain("Dewey");
    expect(html).not.toContain("Explorer");
    expect(html).not.toContain("Completed");
  });
});
