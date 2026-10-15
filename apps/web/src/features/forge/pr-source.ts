import { prFromUrl } from "@ace/forge/pr-reference";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { actionErrorText } from "@ace/ui-core";
import { failureCode, readForge } from "./source.ts";
export function usePrSource(workspaceId: string | undefined, url: string | undefined) {
  let pr;
  try {
    pr = url ? prFromUrl(url) : undefined;
  } catch {
    pr = undefined;
  }
  const query = useDaemonQuery({
    queryKey: ["forge", workspaceId, "prSource", pr],
    enabled: Boolean(workspaceId && pr),
    retry: false,
    refetchOnReconnect: "always",
    staleTime: 0,
    read: async (client, signal) => {
      if (!workspaceId || !pr) throw new Error("No source PR.");
      const value = await readForge(
        client,
        { op: "forge.pr.detail", workspaceId, repository: pr.repository, number: pr.number },
        signal,
      );
      if (value.resource !== "prDetail") throw new Error("No source PR.");
      return value.value;
    },
  });
  const detail = query.data;
  return {
    loading: Boolean(url && pr && !query.isError && !detail),
    selection: detail ? { ref: detail.status.ref, headSha: detail.status.headSha } : undefined,
    text: detail
      ? `Work on GitHub PR #${detail.status.ref.number}: ${detail.status.title}\n${detail.status.url}\n\n${detail.headBranch} → ${detail.baseBranch}\n\n${detail.body}`
      : undefined,
    problem:
      url && !pr
        ? "The PR URL is invalid."
        : query.isError
          ? `The source PR couldn't load. ${actionErrorText(failureCode(query.error))}`
          : detail && !detail.headRepository
            ? "This PR's source repository was deleted."
            : url && !detail
              ? "Loading source PR…"
              : undefined,
  };
}
