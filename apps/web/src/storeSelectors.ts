import { type ThreadId } from "@ace/contracts";
import { useMemo } from "react";
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
  const selector = useMemo(() => selectProjectById(projectId), [projectId]);
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = useMemo(() => selectThreadById(threadId), [threadId]);
  return useStore(selector);
}

export function useSidebarThreadSummaryById(
  threadId: ThreadId | null | undefined,
): SidebarThreadSummary | undefined {
  const selector = useMemo(() => selectSidebarThreadSummaryById(threadId), [threadId]);
  return useStore(selector);
}

export function useThreadIdsByProjectId(
  projectId: Project["id"] | null | undefined,
): readonly ThreadId[] {
  const selector = useMemo(() => selectThreadIdsByProjectId(projectId), [projectId]);
  return useStore(selector);
}

export function useSidebarThreadSummariesByProjectId(
  projectId: Project["id"] | null | undefined,
): readonly SidebarThreadSummary[] {
  const selector = useMemo(() => selectSidebarThreadSummariesByProjectId(projectId), [projectId]);
  return useStore(selector);
}
