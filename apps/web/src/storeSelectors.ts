import { type ThreadId } from "@ace/contracts";
import {
  selectProjectById,
  selectSidebarThreadSummariesByProjectId,
  selectSidebarThreadSummaryById,
  selectThreadIdsByProjectId,
  selectThreadById,
  useStore,
} from "./store";
import { type Project, type SidebarThreadSummary, type Thread } from "./types";

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = selectProjectById(projectId);
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = selectThreadById(threadId);
  return useStore(selector);
}

export function useSidebarThreadSummaryById(
  threadId: ThreadId | null | undefined,
): SidebarThreadSummary | undefined {
  const selector = selectSidebarThreadSummaryById(threadId);
  return useStore(selector);
}

function useThreadIdsByProjectId(projectId: Project["id"] | null | undefined): readonly ThreadId[] {
  const selector = selectThreadIdsByProjectId(projectId);
  return useStore(selector);
}

export function useSidebarThreadSummariesByProjectId(
  projectId: Project["id"] | null | undefined,
): readonly SidebarThreadSummary[] {
  const selector = selectSidebarThreadSummariesByProjectId(projectId);
  return useStore(selector);
}
