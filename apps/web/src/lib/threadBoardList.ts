import type { ThreadId } from "@ace/contracts";

import {
  orderBoardPanes,
  type ChatThreadBoardLayoutNode,
  type ChatThreadBoardSplitState,
} from "../chatThreadBoardStore";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, SidebarThreadSummary } from "../types";

interface ThreadBoardLayoutSummary {
  columns: number;
  depth: number;
  rows: number;
}

export interface SidebarBoardListItem {
  readonly activityLabel: string;
  readonly projectLabel: string | null;
  readonly split: ChatThreadBoardSplitState;
  readonly splitLabel: string;
  readonly threadCountLabel: string;
  readonly threadPreview: string;
}

function summarizeThreadBoardLayout(
  node: ChatThreadBoardLayoutNode | null,
): ThreadBoardLayoutSummary | null {
  if (!node) {
    return null;
  }
  if (node.kind === "pane") {
    return {
      columns: 1,
      depth: 0,
      rows: 1,
    };
  }

  const childSummaries = node.children
    .map((child) => summarizeThreadBoardLayout(child))
    .filter((summary): summary is ThreadBoardLayoutSummary => summary !== null);
  if (childSummaries.length === 0) {
    return null;
  }

  return {
    columns:
      node.axis === "horizontal"
        ? childSummaries.reduce((total, child) => total + child.columns, 0)
        : childSummaries.reduce((max, child) => Math.max(max, child.columns), 0),
    depth: childSummaries.reduce((max, child) => Math.max(max, child.depth), 0) + 1,
    rows:
      node.axis === "vertical"
        ? childSummaries.reduce((total, child) => total + child.rows, 0)
        : childSummaries.reduce((max, child) => Math.max(max, child.rows), 0),
  };
}

function formatThreadCountLabel(threadCount: number): string {
  return threadCount === 1 ? "1 thread" : `${threadCount} threads`;
}

export function describeThreadBoardLayout(
  layoutRoot: ChatThreadBoardLayoutNode | null,
  paneCount: number,
): string {
  if (paneCount <= 1) {
    return "Single thread";
  }

  const summary = summarizeThreadBoardLayout(layoutRoot);
  if (!summary) {
    return `${paneCount}-way split`;
  }

  if (summary.rows === 1) {
    return `${summary.columns}-column split`;
  }
  if (summary.columns === 1) {
    return `${summary.rows}-row split`;
  }
  if (summary.depth <= 1) {
    return `${summary.columns} x ${summary.rows} grid`;
  }
  return `${summary.columns} x ${summary.rows} nested split`;
}

export function buildThreadBoardPreview(
  titles: ReadonlyArray<string>,
  maxVisibleTitles = 2,
): string {
  const normalizedTitles = titles
    .map((title) => title.trim().replace(/\s+/g, " "))
    .filter((title) => title.length > 0);
  if (normalizedTitles.length === 0) {
    return "Untitled threads";
  }

  const visibleTitles = normalizedTitles.slice(0, Math.max(1, maxVisibleTitles));
  const hiddenCount = normalizedTitles.length - visibleTitles.length;
  return hiddenCount > 0
    ? `${visibleTitles.join(", ")} +${hiddenCount} more`
    : visibleTitles.join(", ");
}

export function buildSidebarBoardListItem(input: {
  readonly projectById: ReadonlyMap<Project["id"], Pick<Project, "name">>;
  readonly split: ChatThreadBoardSplitState;
  readonly threadById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
}): SidebarBoardListItem {
  const orderedPanes = orderBoardPanes(input.split.panes, input.split.layoutRoot);
  const titles = orderedPanes.map(
    (pane) => input.threadById[pane.threadId]?.title?.trim() || "Untitled thread",
  );
  const projectIds = new Set<SidebarThreadSummary["projectId"]>();

  for (const pane of orderedPanes) {
    const thread = input.threadById[pane.threadId];
    if (thread?.projectId) {
      projectIds.add(thread.projectId);
    }
  }

  const projectLabel =
    projectIds.size === 0
      ? null
      : projectIds.size === 1
        ? (input.projectById.get([...projectIds][0] as Project["id"])?.name ?? null)
        : `${projectIds.size} projects`;

  return {
    activityLabel: formatRelativeTimeLabel(input.split.updatedAt),
    projectLabel,
    split: input.split,
    splitLabel: describeThreadBoardLayout(input.split.layoutRoot, orderedPanes.length),
    threadCountLabel: formatThreadCountLabel(orderedPanes.length),
    threadPreview: buildThreadBoardPreview(titles),
  };
}

export function createThreadBoardPreviewTitles(
  threadIds: ReadonlyArray<ThreadId>,
  threadById: Readonly<Record<string, SidebarThreadSummary | undefined>>,
): string[] {
  return threadIds.map((threadId) => threadById[threadId]?.title?.trim() || "Untitled thread");
}
