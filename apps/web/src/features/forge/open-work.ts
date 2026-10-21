import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueList,
  type ForgePrList,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";

/** Open work changes slowly; a minute keeps reopening New thread from hitting GitHub. */
const fresh = 60_000;

/**
 * The project's open pull requests, drafts included, matching `search` (all when empty), newest
 * activity first: the first page of up to 25, and the total. Fails when the project has no forge.
 */
export function useOpenPullRequests(workspaceId: string, search = "", enabled = true) {
  return useDaemonQuery<ForgePrList>({
    queryKey: ["forge", workspaceId, "openPullRequests", search],
    enabled,
    retry: false,
    staleTime: fresh,
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
    staleTime: fresh,
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
    staleTime: fresh,
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
