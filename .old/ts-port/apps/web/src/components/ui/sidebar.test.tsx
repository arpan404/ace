import { renderToStaticMarkup } from "react-dom/server";
import { ProjectId, ThreadId, TurnId, type GitStatusResult } from "@ace/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarProvider,
} from "./sidebar";
import { SidebarThreadRow } from "../sidebar/SidebarThreadRow";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";

function countNestedButtonDescendants(html: string): number {
  let nestedButtonCount = 0;
  let buttonDepth = 0;
  const buttonTagPattern = /<\/?button\b[^>]*>/g;
  for (const match of html.matchAll(buttonTagPattern)) {
    if (match[0].startsWith("</")) {
      buttonDepth = Math.max(0, buttonDepth - 1);
      continue;
    }
    if (buttonDepth > 0) {
      nestedButtonCount += 1;
    }
    buttonDepth += 1;
  }
  return nestedButtonCount;
}

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  afterEach(() => {
    const initialAppState = useStore.getInitialState();
    initialAppState.projects = [];
    initialAppState.threads = [];
    initialAppState.threadsById = {};
    initialAppState.sidebarThreadsById = {};
    initialAppState.threadIdsByProjectId = {};
    initialAppState.dismissedThreadErrorKeysById = {};
    initialAppState.bootstrapComplete = false;
    useStore.getState().resetToInitialState();
    useUiStateStore.setState({
      activeThreadId: null,
      previousActiveThreadId: null,
      threadLastVisitedAtById: {},
    });
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("keeps thread row actions outside the primary thread button", () => {
    const projectId = ProjectId.makeUnsafe("project-sidebar-row-test");
    const threadId = ThreadId.makeUnsafe("thread-sidebar-row-test");
    const now = "2026-03-09T10:00:00.000Z";
    const sidebarThreadsById = {
      [threadId]: {
        id: threadId,
        projectId,
        title: "Thread with actions",
        interactionMode: "default",
        session: null,
        createdAt: now,
        archivedAt: null,
        updatedAt: now,
        latestTurn: null,
        branch: "feature/sidebar",
        worktreePath: "/tmp/sidebar-row-test",
        latestUserMessageAt: now,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        isErrorDismissed: false,
      },
    } satisfies Record<string, SidebarThreadSummary>;
    const threadIdsByProjectId = {
      [projectId]: [threadId],
    };
    useStore.getInitialState().sidebarThreadsById = sidebarThreadsById;
    useStore.getInitialState().threadIdsByProjectId = threadIdsByProjectId;
    useStore.setState((state) => ({
      ...state,
      sidebarThreadsById,
      threadIdsByProjectId,
    }));

    const pr = {
      number: 42,
      title: "Sidebar row",
      url: "https://example.com/pull/42",
      baseBranch: "main",
      headBranch: "feature/sidebar",
      state: "open",
    } satisfies NonNullable<GitStatusResult["pr"]>;
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuSub>
          <SidebarThreadRow
            threadId={threadId}
            orderedProjectThreadIds={[threadId]}
            routeThreadId={null}
            activeRouteConnectionUrl="ws://localhost"
            connectionUrl="ws://localhost"
            selectedThreadIds={new Set()}
            showThreadJumpHints={false}
            jumpLabel={null}
            appSettingsConfirmThreadArchive
            isPinned
            renamingThreadId={null}
            renamingTitle=""
            setRenamingTitle={() => {}}
            renamingInputRef={{ current: null }}
            renamingCommittedRef={{ current: false }}
            confirmingArchiveThreadId={null}
            setConfirmingArchiveThreadId={() => {}}
            confirmArchiveButtonRefs={{ current: new Map() }}
            handleThreadClick={() => {}}
            navigateToThread={() => {}}
            prefetchThreadHistory={() => {}}
            handleMultiSelectContextMenu={async () => {}}
            handleThreadContextMenu={async () => {}}
            clearSelection={() => {}}
            commitRename={async () => {}}
            cancelRename={() => {}}
            attemptArchiveThread={async () => {}}
            onTogglePinnedThread={() => {}}
            openPrLink={() => {}}
            pr={pr}
          />
        </SidebarMenuSub>
      </SidebarProvider>,
    );

    expect(html).toContain(`data-testid="thread-row-${threadId}"`);
    expect(html).toContain(`data-testid="thread-pin-${threadId}"`);
    expect(html).toContain(`data-testid="thread-archive-${threadId}"`);
    expect(countNestedButtonDescendants(html)).toBe(0);
  });

  it("keeps archive available when a stale running session points at a completed turn", () => {
    const projectId = ProjectId.makeUnsafe("project-sidebar-row-completed");
    const threadId = ThreadId.makeUnsafe("thread-sidebar-row-completed");
    const turnId = TurnId.makeUnsafe("turn-sidebar-row-completed");
    const now = "2026-03-09T10:00:00.000Z";
    const sidebarThreadsById = {
      [threadId]: {
        id: threadId,
        projectId,
        title: "Completed thread",
        interactionMode: "default",
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: now,
          updatedAt: "2026-03-09T10:05:00.000Z",
        },
        createdAt: now,
        archivedAt: null,
        updatedAt: "2026-03-09T10:05:00.000Z",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: "2026-03-09T10:05:00.000Z",
          assistantMessageId: null,
        },
        branch: null,
        worktreePath: null,
        latestUserMessageAt: now,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        isErrorDismissed: false,
      },
    } satisfies Record<string, SidebarThreadSummary>;
    const threadIdsByProjectId = {
      [projectId]: [threadId],
    };
    useStore.getInitialState().sidebarThreadsById = sidebarThreadsById;
    useStore.getInitialState().threadIdsByProjectId = threadIdsByProjectId;
    useStore.setState((state) => ({
      ...state,
      sidebarThreadsById,
      threadIdsByProjectId,
    }));

    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuSub>
          <SidebarThreadRow
            threadId={threadId}
            orderedProjectThreadIds={[threadId]}
            routeThreadId={null}
            activeRouteConnectionUrl="ws://localhost"
            connectionUrl="ws://localhost"
            selectedThreadIds={new Set()}
            showThreadJumpHints={false}
            jumpLabel={null}
            appSettingsConfirmThreadArchive
            isPinned={false}
            renamingThreadId={null}
            renamingTitle=""
            setRenamingTitle={() => {}}
            renamingInputRef={{ current: null }}
            renamingCommittedRef={{ current: false }}
            confirmingArchiveThreadId={null}
            setConfirmingArchiveThreadId={() => {}}
            confirmArchiveButtonRefs={{ current: new Map() }}
            handleThreadClick={() => {}}
            navigateToThread={() => {}}
            prefetchThreadHistory={() => {}}
            handleMultiSelectContextMenu={async () => {}}
            handleThreadContextMenu={async () => {}}
            clearSelection={() => {}}
            commitRename={async () => {}}
            cancelRename={() => {}}
            attemptArchiveThread={async () => {}}
            onTogglePinnedThread={() => {}}
            openPrLink={() => {}}
            pr={null}
          />
        </SidebarMenuSub>
      </SidebarProvider>,
    );

    expect(html).toContain(`data-testid="thread-archive-${threadId}"`);
  });
});
