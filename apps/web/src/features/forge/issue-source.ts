import { issueFromUrl } from "@ace/forge/pr-reference";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";
export function useIssueSource(workspaceId: string | undefined, url: string | undefined) {
  let issue;
  try {
    issue = url ? issueFromUrl(url) : undefined;
  } catch {
    issue = undefined;
  }
  const query = useDaemonQuery({
    queryKey: ["forge", workspaceId, "issueSource", issue],
    enabled: Boolean(workspaceId && issue),
    retry: false,
    refetchOnReconnect: "always",
    read: async (client, signal) => {
      if (!workspaceId || !issue) throw new Error("No source issue.");
      const value = await readForge(
        client,
        {
          op: "forge.issue.detail",
          workspaceId,
          repository: issue.repository,
          number: issue.number,
        },
        signal,
      );
      if (value.resource !== "issueDetail") throw new Error("No source issue.");
      return value.value;
    },
  });
  return {
    ref: query.data?.ref,
    text: query.data
      ? `Work on GitHub issue #${query.data.ref.number}: ${query.data.title}\n${query.data.url}\n\n${query.data.body}`
      : undefined,
    problem:
      url && !issue
        ? "The issue URL is invalid."
        : query.isError
          ? "The source issue could not load. Reopen it after reconnecting."
          : url && !query.data
            ? "Loading source issue…"
            : undefined,
  };
}
