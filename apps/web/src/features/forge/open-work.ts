import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueList,
  type ForgePrList,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";

/**
 * Open work changes slowly. A list read in the last minute is reused (the daemon keeps its own
 * minute too, shared by every window); an older one stays on screen while it refreshes, kept for
 * half an hour after New thread closes so reopening it shows the lists at once.
 */
const cached = { staleTime: 60_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false } as const;

/**
 * The project's open pull requests, drafts included, matching `search` (all when empty), newest
 * activity first: the first page of up to 25, and the total. Fails when the project has no forge.
 */
export function useOpenPullRequests(workspaceId: string, search = "", enabled = true) {
  return useDaemonQuery<ForgePrList>({
    queryKey: ["forge", workspaceId, "openPullRequests", search],
    enabled,
    retry: false,
    ...cached,
    // A new search keeps the last results on screen until its own arrive.
    placeholderData: (previous) => previous,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.pr.list",
          workspaceId,
          query: ForgePrSearch.parse({ state: "active", search }),
        },
        signal,
      );
      if (value.resource !== "prList") throw new Error("No pull request list.");
      return value.value;
    },
  });
}

/**
 * The project's open pull requests whose checks failed, newest activity first, however long ago
 * they were last touched: the first page of up to 25. Fails when the project has no forge.
 */
export function useFailingPullRequests(workspaceId: string) {
  return useDaemonQuery<ForgePrList>({
    queryKey: ["forge", workspaceId, "failingPullRequests"],
    retry: false,
    ...cached,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.pr.list",
          workspaceId,
          query: ForgePrSearch.parse({ state: "active", ci: "failure" }),
        },
        signal,
      );
      if (value.resource !== "prList") throw new Error("No pull request list.");
      return value.value;
    },
  });
}

/**
 * The project's open issues matching `search` (all when empty), newest activity first: the first
 * page of up to 25, and the total. Fails when the project has no forge.
 */
export function useOpenIssues(workspaceId: string, search = "", enabled = true) {
  return useDaemonQuery<ForgeIssueList>({
    queryKey: ["forge", workspaceId, "openIssues", search],
    enabled,
    retry: false,
    ...cached,
    // A new search keeps the last results on screen until its own arrive.
    placeholderData: (previous) => previous,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId, query: ForgeIssueSearch.parse({ search }) },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      return value.value;
    },
  });
}
