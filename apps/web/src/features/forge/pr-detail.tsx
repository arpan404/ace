import { useEffect, useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { ChatCircleIcon, GitCommitIcon, SortAscendingIcon } from "@phosphor-icons/react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { ForgeRepository } from "@ace/protocol";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PrActivity } from "./pr-activity.tsx";
import { PrHeader } from "./pr-header.tsx";
import { PrLifecycle } from "./pr-lifecycle.tsx";
import { PrSummary } from "./pr-summary.tsx";
import { PrComposer } from "./pr-composer.tsx";
import { PrChecksPill } from "./pr-presentation.tsx";
import { PrFiles } from "./pr-files.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewWorkspace } from "./pr-review-context.tsx";

export function prWorkspaceTab(tab: string): "summary" | "timeline" | "code" {
  return tab === "timeline" || tab === "commits"
    ? "timeline"
    : tab === "code" || tab === "files"
      ? "code"
      : "summary";
}
export function PrDetail(props: {
  workspaceId: string;
  repository?: ForgeRepository | undefined;
  number: number;
  tab: string;
  onTab(tab: string): void;
  onState?: ((state: import("@ace/protocol").ForgePrStatus["state"]) => void) | undefined;
  onBack?(): void;
  onOpen(number: number): void;
  extensions?: PrWorkspaceExtensions | undefined;
}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [actionsOpen, setActionsOpen] = useState(false);
  const ready = useConnectionState() === "ready";
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
  const detail = query.data;
  const tab = prWorkspaceTab(props.tab);
  const onState = props.onState;
  useEffect(() => {
    if (detail) onState?.(detail.status.state);
  }, [detail, onState]);
  const refresh = async () => {
    setRefreshVersion((version) => version + 1);
    return !(await query.refetch()).isError;
  };
  const context: PrWorkspaceContext | undefined = detail
    ? {
        workspaceId: props.workspaceId,
        detail,
        disabled: !ready || query.isError || query.isFetching || detail.writeState !== undefined,
        refresh,
      }
    : undefined;
  const onOpen = props.onOpen;
  return (
    <article
      aria-label={`Pull request #${props.number}`}
      className="relative flex h-full min-h-0 flex-col bg-panel"
    >
      <div className="px-4">
        <QueryState query={query} />
      </div>
      {context && (
        <PrReviewWorkspace
          key={JSON.stringify(context.detail.status.ref)}
          workspaceId={props.workspaceId}
          detail={context.detail}
          disabled={context.disabled}
          onRefresh={() => void refresh()}
          header={
            <PrHeader
              context={context}
              extensions={props.extensions}
              onBack={props.onBack}
              actionsOpen={actionsOpen}
              onActionsOpen={setActionsOpen}
            />
          }
        >
          {context.disabled && (
            <p
              role="status"
              className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
            >
              {detail?.writeState
                ? "Refresh GitHub to reconcile the previous action before making another change."
                : query.isError
                  ? "Refresh failed. Write actions are disabled until a successful refresh."
                  : !ready
                    ? "Reconnect to make changes."
                    : "Refreshing GitHub. Write actions are temporarily disabled."}
            </p>
          )}
          <Tabs
            value={tab}
            onValueChange={(value) => typeof value === "string" && props.onTab(value)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <TabsList aria-label="Pull request detail" className="rounded-card bg-muted p-0.5">
                <TabsTab className="data-active:bg-panel data-active:shadow-sm" value="summary">
                  Summary
                </TabsTab>
                <TabsTab className="data-active:bg-panel data-active:shadow-sm" value="timeline">
                  Timeline
                </TabsTab>
                <TabsTab className="data-active:bg-panel data-active:shadow-sm" value="code">
                  Code
                </TabsTab>
              </TabsList>
              {tab === "summary" && (
                <PrChecksPill ci={context.detail.status.ci} checks={context.detail.status.checks} />
              )}
              {tab === "timeline" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    aria-label={`${context.detail.status.comments.length} comments`}
                    className="inline-flex items-center gap-1"
                  >
                    <ChatCircleIcon aria-hidden size={14} />
                    {context.detail.status.comments.length}
                  </span>
                  <span
                    aria-label={`${context.detail.commits} commits`}
                    className="inline-flex items-center gap-1"
                  >
                    <GitCommitIcon aria-hidden size={14} />
                    {context.detail.commits}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
                  >
                    <SortAscendingIcon aria-hidden size={14} />
                    {order === "newest" ? "Newest first" : "Oldest first"} ⇅
                  </Button>
                </div>
              )}
            </div>
            <TabsPanel value="summary" className="overflow-auto">
              <PrSummary
                context={context}
                extensions={props.extensions}
                onReviewers={() => setActionsOpen(true)}
                onOpen={onOpen}
                lifecycle={
                  <PrLifecycle
                    key={JSON.stringify(context.detail.status.ref)}
                    workspaceId={props.workspaceId}
                    detail={context.detail}
                    refreshVersion={refreshVersion}
                    writeDisabled={context.disabled}
                    onRefresh={() => void refresh()}
                  />
                }
              />
            </TabsPanel>
            <TabsPanel value="timeline" className="overflow-auto">
              <PrActivity workspaceId={props.workspaceId} detail={context.detail} order={order} />
            </TabsPanel>
            <TabsPanel value="code" className="overflow-auto">
              <PrFiles
                workspaceId={props.workspaceId}
                repository={context.detail.status.ref.repository}
                detail={context.detail}
                context={context}
                extensions={props.extensions}
              />
            </TabsPanel>
          </Tabs>
          <PrComposer context={context} extensions={props.extensions} />
        </PrReviewWorkspace>
      )}
    </article>
  );
}
