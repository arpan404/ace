import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrMarkdown } from "./pr-markdown.tsx";
import { PrCompareFiles } from "./pr-compare-files.tsx";

/** Hosts with read adapters use the same diff renderer without offering unsupported writes. */
export function HostedPrReader(props: {
  context: PrWorkspaceContext;
  onBack?: (() => void) | undefined;
  tab: string;
  onTab(tab: string): void;
}) {
  const { context } = props;
  const { detail } = context;
  const { status } = detail;
  const code = props.tab === "code";
  const [page, setPage] = useState(1);
  const files = useDaemonQuery({
    queryKey: [
      "forge",
      context.workspaceId,
      status.ref,
      "hosted-files",
      status.headSha,
      detail.baseSha,
      page,
    ],
    enabled: code,
    staleTime: 60_000,
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.files",
          workspaceId: context.workspaceId,
          repository: status.ref.repository,
          number: status.ref.number,
          headSha: status.headSha,
          baseSha: detail.baseSha,
          page,
        },
        signal,
      );
      if (result.resource !== "prFiles") throw new Error("Couldn't read changed files.");
      return result.value;
    },
  });
  const host = status.ref.repository.forge === "origin" ? "Cursor Origin" : "GitLab";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[var(--forge-gutter,1rem)] py-4">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          {props.onBack && (
            <Button variant="ghost" size="sm" onClick={props.onBack}>
              Back
            </Button>
          )}
          <WebLink href={status.url} className="text-ui text-muted-foreground">
            Open on {host}
          </WebLink>
        </div>
        <h2 className="text-lg font-semibold">
          {status.title} <span className="text-muted-foreground">#{status.ref.number}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          {status.state} · {detail.author} · {detail.headBranch} → {detail.baseBranch}
        </p>
        <p className="text-xs text-muted-foreground">
          Read only in Ace. Reviews, comments, checks and merge actions are available on {host}.
        </p>
        <div className="flex items-center gap-2 border-b border-border py-2">
          <Button
            variant={code ? "ghost" : "secondary"}
            size="sm"
            onClick={() => props.onTab("summary")}
          >
            Summary
          </Button>
          <Button
            variant={code ? "secondary" : "ghost"}
            size="sm"
            onClick={() => props.onTab("code")}
          >
            Changed files
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={context.disabled}
            onClick={() => void context.refresh()}
          >
            Refresh
          </Button>
        </div>
      </header>
      <section className="py-4">
        {!code ? (
          <PrMarkdown text={detail.body || "No description."} context={context} onOpen={() => {}} />
        ) : files.isError ? (
          <div role="alert">
            <p className="text-ui text-muted-foreground">{files.error.message}</p>
            <Button size="sm" onClick={() => void files.refetch()}>
              Retry
            </Button>
          </div>
        ) : !files.data ? (
          <p role="status" className="text-ui text-muted-foreground">
            Loading changed files…
          </p>
        ) : (
          <>
            <PrCompareFiles files={files.data.files} />
            {files.data.files.length === 0 && (
              <p className="text-ui text-muted-foreground">No changed files on this page.</p>
            )}
            {files.data.truncated && (
              <p role="status" className="text-xs text-muted-foreground">
                Some changes are omitted. Open the pull request on {host} to see the full diff.
              </p>
            )}
            <div className="flex items-center gap-2 py-3">
              <Button size="sm" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
                Previous page
              </Button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <Button
                size="sm"
                disabled={!files.data.nextPage}
                onClick={() => setPage(files.data?.nextPage ?? page)}
              >
                Next page
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
