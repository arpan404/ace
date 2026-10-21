import type {
  ForgeIssueDetail,
  ForgeIssueList,
  ForgeIssueSearch,
  ForgePrList,
  ForgePrSearch,
} from "@ace/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";

/**
 * A list read again after half a minute, or when the window comes back to it; the last answer
 * stays on screen while a new search or filter reads, so rows never blank out mid-typing.
 */
const listed = { staleTime: 30_000, gcTime: 10 * 60_000, retry: false } as const;

/** One page of up to 25 of a project's pull requests matching `query`. */
export function usePrListPage(project: string | undefined, query: ForgePrSearch) {
  return useDaemonQuery<ForgePrList>({
    queryKey: ["forge", project, "browse", "prList", query],
    enabled: !!project,
    ...listed,
    ...(query.page === 1 ? { placeholderData: keepPreviousData } : {}),
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.pr.list", workspaceId: project ?? "", query },
        signal,
      );
      if (value.resource !== "prList") throw new Error("No pull request list.");
      return value.value;
    },
  });
}

/** One page of up to 25 of a project's issues matching `query`. */
export function useIssueListPage(project: string | undefined, query: ForgeIssueSearch) {
  return useDaemonQuery<ForgeIssueList>({
    queryKey: ["forge", project, "browse", "issueList", query],
    enabled: !!project,
    ...listed,
    ...(query.page === 1 ? { placeholderData: keepPreviousData } : {}),
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId: project ?? "", query },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      return value.value;
    },
  });
}

export const issueDetailKey = (project: string, number: number) =>
  ["forge", project, "browse", "issueDetail", number] as const;

/** One issue: its body, labels, people, permissions and the threads linked to it. */
export function useIssueDetail(project: string, number: number) {
  return useDaemonQuery<ForgeIssueDetail>({
    queryKey: issueDetailKey(project, number),
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    retry: false,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.detail", workspaceId: project, number },
        signal,
      );
      if (value.resource !== "issueDetail") throw new Error("No issue.");
      return value.value;
    },
  });
}
