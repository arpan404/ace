import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueList,
  type ForgePrList,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";

/** Open work changes slowly; a minute keeps reopening New thread from hitting GitHub. */
const fresh = 60_000;

/**
 * The project's open pull requests matching `search` (all when empty), newest activity first:
 * the first page of up to 25, and the total. Fails when the project has no forge.
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
        { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({ search }) },
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
