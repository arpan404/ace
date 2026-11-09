import { useCallback, useState } from "react";
import {
  forgeDisplayName,
  forgeErrorText,
  hostedFilesUnavailableText,
  hostedReferenceAddress,
  hostedReviewLine,
  knownFileCount,
  reviewNoun,
} from "@ace/ui-core";
import { StateWords } from "@/components/forge-marks.tsx";
import { useBackLabel } from "@/components/back-label.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { WorkHeading, WorkTitle } from "@/components/work-heading.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { failureCode, readForge } from "@/lib/forge-read.ts";
import type { PrWorkspaceContext } from "./pr-extensions.ts";
import { PrCompareFiles } from "./pr-compare-files.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { wordTab } from "./pr-tabs.tsx";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A review on a host ace only reads (Cursor Origin, GitLab): the page's heading, Summary and
 * Code as the GitHub page's word tabs, and one line saying the rest happens on the host. It
 * never offers merge, review or comment controls.
 */
export function HostedPrReader(props: {
  context: PrWorkspaceContext;
  onBack?: (() => void) | undefined;
  tab: string;
  onTab(tab: string): void;
}) {
  const { context } = props;
  const { detail } = context;
  const { status } = detail;
  const { repository } = status.ref;
  const host = forgeDisplayName(repository.forge);
  const noun = reviewNoun(repository.forge);
  const backLabel = useBackLabel("Pull requests");
  const openWeb = useOpenWebAddress();
  const code = props.tab === "code";
  // The host can't list this review's files: say so, never show an empty list as complete.
  const filesUnavailable = detail.unavailableResources?.includes("files") === true;
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
    enabled: code && !filesUnavailable,
    staleTime: 60_000,
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.files",
          workspaceId: context.workspaceId,
          repository,
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
  const forgeReference = useCallback(
    (reference: { kind: string; target: string }) => hostedReferenceAddress(reference, repository),
    [repository],
  );
  // A count the host didn't give is no number at all, never "0".
  const count = knownFileCount(detail) ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="shrink-0 px-[var(--forge-gutter,1rem)] pt-4 pb-3">
        <WorkHeading
          back={props.onBack && { label: backLabel, onBack: props.onBack }}
          title={<WorkTitle text={status.title} number={status.ref.number} />}
          actions={
            <>
              <a
                href={status.url}
                target="_blank"
                rel="noreferrer noopener"
                // Always the host's page: this review is already open here.
                onClick={(event) => {
                  event.preventDefault();
                  void openWeb(status.url, event).catch(() => {});
                }}
                className="inline-flex h-7 items-center rounded-md px-2 text-ui text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
              >
                Open on {host}
              </a>
              <Button
                variant="ghost"
                size="sm"
                disabled={context.disabled}
                onClick={() => void context.refresh()}
              >
                Refresh
              </Button>
            </>
          }
          badge={status.state === "unknown" ? null : <StateWords state={status.state} />}
          byline={
            <>
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
              <span className="text-foreground/85">{detail.author}</span>
              <span>{status.state === "merged" ? "merged into" : "wants to merge into"}</span>
              <span className="font-mono text-xs text-foreground/85">{detail.baseBranch}</span>
              <span>from</span>
              <span className="font-mono text-xs text-foreground/85">{detail.headBranch}</span>
              {detail.updatedAt && (
                <>
                  <span aria-hidden className="text-subtle-foreground">
                    ·
                  </span>
                  <PrTime at={detail.updatedAt} prefix="updated " />
                </>
              )}
            </>
          }
        />
        <p className="mt-2 text-xs text-muted-foreground">{hostedReviewLine(repository.forge)}</p>
      </header>
      <Tabs
        value={code ? "code" : "summary"}
        onValueChange={(value) => {
          if (typeof value === "string") props.onTab(value);
        }}
        className="flex flex-col"
      >
        <div className="shrink-0 border-t border-border py-2">
          <div className="flex items-center px-[var(--forge-gutter,1rem)]">
            <TabsList aria-label={`${capitalized(noun)} detail`} className="-ml-2">
              <TabsTab value="summary" className={wordTab}>
                Summary
              </TabsTab>
              <TabsTab value="code" className={wordTab}>
                Code
                {count > 0 && (
                  <span
                    aria-hidden
                    className="ml-1 font-normal text-subtle-foreground tabular-nums"
                  >
                    {count}
                  </span>
                )}
              </TabsTab>
            </TabsList>
          </div>
        </div>
        <TabsPanel
          value="summary"
          className="border-t border-border px-[var(--forge-gutter,1rem)] py-4"
        >
          <Prose
            text={detail.body || "No description."}
            className="text-ui leading-normal text-muted-foreground"
            forgeReference={forgeReference}
          />
        </TabsPanel>
        <TabsPanel
          value="code"
          className="border-t border-border px-[var(--forge-gutter,1rem)] py-4"
        >
          {filesUnavailable ? (
            <p className="text-ui text-muted-foreground">
              {hostedFilesUnavailableText(repository.forge)}
            </p>
          ) : files.isError ? (
            <div role="alert" className="flex items-center gap-2">
              <p className="text-ui text-muted-foreground">
                {forgeErrorText(failureCode(files.error), status.ref.repository.forge)}
              </p>
              <Button size="sm" variant="ghost" onClick={() => void files.refetch()}>
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
                  Some changes are omitted. Open the {noun} on {host} to see the full diff.
                </p>
              )}
              {(page > 1 || files.data.nextPage) && (
                <div className="flex items-center gap-2 py-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page === 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous page
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!files.data.nextPage}
                    onClick={() => setPage(files.data?.nextPage ?? page)}
                  >
                    Next page
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
