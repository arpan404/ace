import {
  ForgeIssueSearch,
  ForgePrSearch,
  type ForgeIssueRow,
  type ForgePrRow,
} from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";

/** Open work changes slowly; a minute keeps reopening New thread from hitting GitHub. */
const fresh = 60_000;

/** The project's open pull requests, newest activity first. Fails when it has no forge. */
export function useOpenPullRequests(workspaceId: string) {
  return useDaemonQuery<readonly ForgePrRow[]>({
    queryKey: ["forge", workspaceId, "openPullRequests"],
    retry: false,
    staleTime: fresh,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({}) },
        signal,
      );
      if (value.resource !== "prList") throw new Error("No pull request list.");
      return value.value.items;
    },
  });
}

/** The project's open issues, newest activity first. Fails when it has no forge. */
export function useOpenIssues(workspaceId: string) {
  return useDaemonQuery<readonly ForgeIssueRow[]>({
    queryKey: ["forge", workspaceId, "openIssues"],
    retry: false,
    staleTime: fresh,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId, query: ForgeIssueSearch.parse({}) },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      return value.value.items;
    },
  });
}
