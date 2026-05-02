import { ProjectId, ThreadId } from "@ace/contracts";
import { describe, expect, it, vi } from "vitest";

import { type ChatThreadBoardSplitState } from "../chatThreadBoardStore";
import {
  buildSidebarBoardListItem,
  buildThreadBoardPreview,
  describeThreadBoardLayout,
} from "./threadBoardList";
import type { Project, SidebarThreadSummary } from "../types";

describe("describeThreadBoardLayout", () => {
  it("describes flat horizontal boards as column splits", () => {
    expect(
      describeThreadBoardLayout(
        {
          axis: "horizontal",
          children: [
            { id: "pane-node-a", kind: "pane", paneId: "pane-a" },
            { id: "pane-node-b", kind: "pane", paneId: "pane-b" },
            { id: "pane-node-c", kind: "pane", paneId: "pane-c" },
          ],
          id: "split-node-root",
          kind: "split",
          ratios: [1 / 3, 1 / 3, 1 / 3],
        },
        3,
      ),
    ).toBe("3-column split");
  });

  it("describes nested boards with rows and columns", () => {
    expect(
      describeThreadBoardLayout(
        {
          axis: "vertical",
          children: [
            {
              axis: "horizontal",
              children: [
                { id: "pane-node-a", kind: "pane", paneId: "pane-a" },
                { id: "pane-node-b", kind: "pane", paneId: "pane-b" },
              ],
              id: "split-node-top",
              kind: "split",
              ratios: [0.5, 0.5],
            },
            {
              axis: "horizontal",
              children: [
                { id: "pane-node-c", kind: "pane", paneId: "pane-c" },
                { id: "pane-node-d", kind: "pane", paneId: "pane-d" },
              ],
              id: "split-node-bottom",
              kind: "split",
              ratios: [0.5, 0.5],
            },
          ],
          id: "split-node-root",
          kind: "split",
          ratios: [0.5, 0.5],
        },
        4,
      ),
    ).toBe("2 x 2 nested split");
  });
});

describe("buildThreadBoardPreview", () => {
  it("keeps the preview compact when more titles exist", () => {
    expect(buildThreadBoardPreview(["Alpha", "Beta", "Gamma"])).toBe("Alpha, Beta +1 more");
  });
});

describe("buildSidebarBoardListItem", () => {
  it("builds project, layout, and preview metadata for a board", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    const projectId = ProjectId.makeUnsafe("project-a");
    const split: ChatThreadBoardSplitState = {
      activePaneId: "pane-a",
      archivedAt: null,
      createdAt: "2026-05-01T11:45:00.000Z",
      id: "split-a",
      layoutRoot: {
        axis: "horizontal",
        children: [
          { id: "pane-node-a", kind: "pane", paneId: "pane-a" },
          { id: "pane-node-b", kind: "pane", paneId: "pane-b" },
        ],
        id: "split-node-root",
        kind: "split",
        ratios: [0.5, 0.5],
      },
      panes: [
        {
          connectionUrl: null,
          id: "pane-a",
          threadId: ThreadId.makeUnsafe("thread-a"),
          title: "Audit codebase",
        },
        {
          connectionUrl: null,
          id: "pane-b",
          threadId: ThreadId.makeUnsafe("thread-b"),
          title: "Rust port",
        },
      ],
      title: "Board A",
      titleMode: "manual",
      titlePaneId: null,
      updatedAt: "2026-05-01T11:55:00.000Z",
    };
    const threadById: Record<string, SidebarThreadSummary> = {
      "thread-a": {
        archivedAt: null,
        branch: null,
        createdAt: "2026-05-01T11:00:00.000Z",
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        id: ThreadId.makeUnsafe("thread-a"),
        interactionMode: "default",
        isErrorDismissed: false,
        latestTurn: null,
        latestUserMessageAt: null,
        projectId,
        session: null,
        title: "Audit codebase",
        updatedAt: "2026-05-01T11:50:00.000Z",
        worktreePath: null,
      },
      "thread-b": {
        archivedAt: null,
        branch: null,
        createdAt: "2026-05-01T11:10:00.000Z",
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        id: ThreadId.makeUnsafe("thread-b"),
        interactionMode: "default",
        isErrorDismissed: false,
        latestTurn: null,
        latestUserMessageAt: null,
        projectId,
        session: null,
        title: "Rust port",
        updatedAt: "2026-05-01T11:52:00.000Z",
        worktreePath: null,
      },
    };
    const projectById = new Map<Project["id"], Pick<Project, "name">>([
      [projectId, { name: "Ace" }],
    ]);

    expect(
      buildSidebarBoardListItem({
        projectById,
        split,
        threadById,
      }),
    ).toEqual({
      activityLabel: "5m ago",
      projectLabel: "Ace",
      split,
      splitLabel: "2-column split",
      threadCountLabel: "2 threads",
      threadPreview: "Audit codebase, Rust port",
    });

    vi.useRealTimers();
  });
});
