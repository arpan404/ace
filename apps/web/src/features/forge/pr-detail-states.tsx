import { GitPullRequestIcon } from "@phosphor-icons/react";
import type { ForgePrStatus, ForgeRepository } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { pullRequestTone } from "@/components/pull-request-state.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { cn } from "@/lib/cn.ts";
import { failureCode } from "@/lib/forge-read.ts";

const tabs = ["Summary", "Timeline", "Code"];

/** The header and tabs in outline while the PR's detail is read, filled from what the tab knows. */
export function PrGhost(props: {
  repository?: ForgeRepository | undefined;
  number: number;
  state?: ForgePrStatus["state"] | undefined;
}) {
  return (
    <LoadingRegion label={`Reading pull request #${props.number}`} className="flex flex-col">
      <div className="px-[var(--forge-gutter,1rem)] pt-2 pb-2">
        <p className="flex h-7 items-center gap-1 text-xs text-muted-foreground">
          {props.repository && (
            <span className="font-medium">{`${props.repository.owner}/${props.repository.name}`}</span>
          )}
          <span
            className={cn(
              "font-mono tabular-nums",
              props.state && props.state !== "unknown" && pullRequestTone(props.state),
            )}
          >
            #{props.number}
          </span>
          <Skeleton className="ml-auto h-6 w-28 rounded-sm" />
        </p>
        <div className="mt-1 space-y-2.5 pt-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="w-1/2" />
          <Skeleton className="w-2/3" />
        </div>
      </div>
      <div className="flex items-center gap-0.5 border-t border-border px-[var(--forge-gutter,1rem)] py-2">
        {tabs.map((tab) => (
          <span key={tab} className="px-2.5 text-sm font-medium text-subtle-foreground">
            {tab}
          </span>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A PR that couldn't be read at all: what happened, Retry, and the PR on GitHub. */
export function PrFailure(props: {
  repository?: ForgeRepository | undefined;
  number: number;
  error: Error;
  onRetry(): void;
}) {
  const repository = props.repository;
  const url =
    repository &&
    `https://${repository.host}/${repository.owner}/${repository.name}/pull/${props.number}`;
  const missing = failureCode(props.error) === "forge_not_found";
  return (
    <EmptyState
      icon={GitPullRequestIcon}
      title={
        missing
          ? `Pull request #${props.number} not found`
          : `Couldn't load pull request #${props.number}`
      }
      description={props.error.message}
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={props.onRetry}>
            Retry
          </Button>
          {url && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void openExternal(url).catch(() => {})}
            >
              Open on GitHub
            </Button>
          )}
        </div>
      }
    />
  );
}
