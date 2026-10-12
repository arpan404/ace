import { useState } from "react";
import { PrLifecycle } from "./pr-lifecycle.tsx";
import { PrStack } from "./pr-stack.tsx";
import { PrReviewWorkspace } from "./pr-review-context.tsx";
import {
  PrReviewSubmission,
  PrConversationComposer,
  PrOwnComment,
  PrThreadControls,
} from "./pr-review-forms.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { ForgeRepository } from "@ace/protocol";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { PrActivity } from "./pr-activity.tsx";
import { PrActions } from "./pr-actions.tsx";
import { PrCommits } from "./pr-commits.tsx";
import { PrFiles } from "./pr-files.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";

export function PrDetail(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  number: number;
  tab: string;
  onTab(tab: string): void;
  onOpen(number: number): void;
}) {
  const toast = useToast();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, props.repository, "pr", props.number],
    retry: false,
    staleTime: 15_000,
    refetchOnReconnect: "always",
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.detail",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: props.number,
        },
        signal,
      );
      if (result.resource !== "prDetail") throw new Error("No pull request detail.");
      return result.value;
    },
  });
  const refresh = () => {
    setRefreshVersion((version) => version + 1);
    return query.refetch();
  };
  const detail = query.data;
  const status = detail?.status;
  return (
    <article aria-label={`Pull request #${props.number}`} className="space-y-5">
      <div className="flex items-center gap-3">
        <Button onClick={() => void refresh()}>Refresh PR</Button>
        {status && (
          <Button
            onClick={() =>
              void openExternal(status.url).catch(() =>
                toast.error({ title: "Couldn't open GitHub" }),
              )
            }
          >
            Open on GitHub
          </Button>
        )}
      </div>
      <QueryState query={query} />
      {detail && status && (
        <>
          <div className="flex items-start gap-3">
            <PullRequestGlyph
              state={status.state === "unknown" ? "open" : status.state}
              size={24}
            />
            <div className="min-w-0 space-y-2">
              <h2 className="text-2xl font-semibold tracking-title">
                {status.title} <span className="text-muted-foreground">#{props.number}</span>
              </h2>
              <p className="break-words text-sm text-muted-foreground">
                {status.state} · {detail.author} · {detail.headBranch} → {detail.baseBranch}
              </p>
              <p className="text-sm">{detail.labels.join(" · ")}</p>
              <p className="text-sm">
                Review decision: {detail.reviewDecision ?? "Unknown"} · Requested reviewers:{" "}
                {detail.reviewers.join(", ") || "None"}
              </p>
            </div>
          </div>
          <PrActions
            workspaceId={props.workspaceId}
            key={JSON.stringify(status.ref)}
            detail={detail}
            writeReady={!query.isError && !query.isFetching}
            onRefresh={async () => !(await refresh()).isError}
          />
          <PrLifecycle
            key={JSON.stringify(status.ref)}
            workspaceId={props.workspaceId}
            detail={detail}
            refreshVersion={refreshVersion}
            onRefresh={() => void refresh()}
          />
          <PrStack
            key={JSON.stringify(status.ref)}
            workspaceId={props.workspaceId}
            detail={detail}
            onRefresh={() => void refresh()}
            onOpen={props.onOpen}
          />
          <PrReviewWorkspace
            key={JSON.stringify(status.ref)}
            workspaceId={props.workspaceId}
            detail={detail}
            onRefresh={() => void refresh()}
          >
            <PrReviewSubmission detail={detail} />
            <Tabs
              value={props.tab}
              onValueChange={(tab) => typeof tab === "string" && props.onTab(tab)}
            >
              <TabsList
                aria-label="Pull request detail"
                className="flex-wrap border-b border-border pb-3"
              >
                <TabsTab value="conversation">Conversation</TabsTab>
                <TabsTab value="commits">Commits {detail.commits}</TabsTab>
                <TabsTab value="checks">Checks {status.checks.length}</TabsTab>
                <TabsTab value="files">Files changed {detail.changedFiles}</TabsTab>
              </TabsList>
              <TabsPanel value="conversation" className="space-y-6 pt-5">
                <PrActivity workspaceId={props.workspaceId} pr={status.ref} />
                <section aria-label="Description">
                  <Prose text={detail.body || "No description provided."} />
                </section>
                <ol aria-label="Pull request conversation" className="space-y-5">
                  {status.comments
                    .toSorted(
                      (a, b) =>
                        (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt) ||
                        a.id - b.id,
                    )
                    .map((comment) => (
                      <li
                        key={`${comment.kind}:${comment.id}`}
                        className="border-t border-border pt-4"
                      >
                        <p className="mb-2 text-sm text-muted-foreground">
                          {comment.author} ·{" "}
                          {comment.kind === "inline"
                            ? "Inline review"
                            : comment.kind === "review"
                              ? `Review: ${comment.reviewState ?? "unknown"}`
                              : "PR conversation"}{" "}
                          · {comment.updatedAt}
                          {comment.file ? ` · ${comment.file}:${comment.line ?? ""}` : ""}
                        </p>
                        <Prose text={comment.body} />
                        <PrOwnComment comment={comment} />
                      </li>
                    ))}
                </ol>
                <PrConversationComposer prKey={JSON.stringify(status.ref)} />
                <section aria-label="Review threads" className="space-y-3">
                  {status.reviewThreads.map((thread) => (
                    <details key={thread.id}>
                      <summary className="cursor-pointer text-sm focus-ring">
                        {thread.file}:{thread.line ?? ""} ·{" "}
                        {thread.resolved ? "Resolved" : "Unresolved"}
                        {thread.outdated ? " · Outdated" : ""}
                      </summary>
                      <PrThreadControls
                        id={thread.id}
                        resolved={thread.resolved}
                        replyTo={thread.comments[0]?.id}
                        prKey={JSON.stringify(status.ref)}
                      />
                      {thread.comments.map((comment) => (
                        <div key={comment.id} className="mt-2 border-l border-border pl-4">
                          <p className="text-sm">{comment.author}</p>
                          <Prose text={comment.body} />
                        </div>
                      ))}
                    </details>
                  ))}
                </section>
              </TabsPanel>
              <TabsPanel value="commits" className="pt-5">
                <PrCommits
                  workspaceId={props.workspaceId}
                  repository={status.ref.repository}
                  detail={detail}
                />
              </TabsPanel>
              <TabsPanel value="checks" className="pt-5">
                <p className="mb-4">
                  CI: {status.ci} · Mergeability: {status.mergeability}
                </p>
                {!status.checks.length && <p>No checks reported.</p>}
                <ul>
                  {status.checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex flex-wrap items-center gap-3 border-b border-border py-3"
                    >
                      <span className="flex-1">{check.name}</span>
                      <span>{check.status}</span>
                      {check.url && (
                        <Button
                          onClick={() =>
                            check.url &&
                            void openExternal(check.url).catch(() =>
                              toast.error({ title: "Couldn't open the check" }),
                            )
                          }
                        >
                          Open check
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </TabsPanel>
              <TabsPanel value="files" className="pt-5">
                <PrFiles
                  workspaceId={props.workspaceId}
                  repository={status.ref.repository}
                  detail={detail}
                />
              </TabsPanel>
            </Tabs>
          </PrReviewWorkspace>
        </>
      )}
    </article>
  );
}
