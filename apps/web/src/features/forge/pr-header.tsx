import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  DotsThreeIcon,
  FileIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { pullRequestTone } from "@/components/pull-request-state.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/markdown/code-block.tsx";
import { PrActions } from "./pr-actions.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

export function PrHeader(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onBack?: (() => void) | undefined;
  actionsOpen: boolean;
  onActionsOpen(open: boolean): void;
}) {
  const { detail, disabled, refresh } = props.context;
  const { status } = detail;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const toast = useToast();
  const { copied, copy } = useCopy();
  const open = () =>
    void openExternal(status.url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  return (
    <header className="space-y-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.onBack && (
          <IconButton
            icon={ArrowLeftIcon}
            label="Back to pull requests"
            onClick={props.onBack}
            size="sm"
          />
        )}
        <button
          onClick={open}
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground focus-ring pointer-coarse:min-h-11"
        >
          <span className="truncate">
            {repository.owner}/{repository.name}
          </span>
          <span className={status.state === "unknown" ? "" : pullRequestTone(status.state)}>
            #{status.ref.number}
          </span>
          <ArrowSquareOutIcon aria-hidden size={12} />
          <span className="sr-only">{status.state}, open on GitHub</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {props.extensions?.headerActions?.(props.context)}
          {status.mergeability === "conflicting" && (
            <Popover>
              <PopoverTrigger
                render={<Button variant="outline" size="sm" className="text-destructive" />}
              >
                <WarningIcon aria-hidden size={16} />
                Resolve conflicts
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-2 p-3">
                <PopoverTitle className="text-ui font-medium">Resolve conflicts</PopoverTitle>
                <p className="text-sm text-muted-foreground">
                  Choose where to resolve the conflicts.
                </p>
                <Button size="sm" onClick={open}>
                  Open on GitHub
                </Button>
                {props.extensions?.resolveInWorktree && (
                  <Button
                    disabled={disabled}
                    onClick={() => props.extensions?.resolveInWorktree?.(props.context)}
                  >
                    Resolve in a worktree with an agent
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          )}
          <Popover open={props.actionsOpen} onOpenChange={props.onActionsOpen}>
            <PopoverTrigger
              render={<IconButton icon={DotsThreeIcon} label="Pull request actions" />}
            />
            <PopoverContent align="end" keepMounted className="w-80 max-w-full space-y-2 p-3">
              <PopoverTitle className="text-ui font-medium">Pull request actions</PopoverTitle>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void refresh()}>
                  Refresh PR
                </Button>
                <Button size="sm" onClick={open}>
                  Open on GitHub
                </Button>
              </div>
              {props.extensions?.overflow?.(props.context)}
              <PrActions
                workspaceId={props.context.workspaceId}
                key={JSON.stringify(status.ref)}
                detail={detail}
                writeReady={!disabled}
                onRefresh={refresh}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <h2 className="text-ui leading-5 font-medium">{status.title}</h2>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
        <span>{detail.author}</span>
        <span aria-hidden className="text-subtle-foreground">
          ·
        </span>
        <PrTime at={detail.updatedAt} prefix="updated " />
        <button
          type="button"
          aria-label={copied ? "Checkout command copied" : "Copy checkout command"}
          onClick={() => copy(checkout)}
          title={checkout}
          className="ml-auto max-w-full truncate rounded-sm px-1 py-0.5 font-mono text-xs pointer-coarse:min-h-11 text-muted-foreground hover:bg-accent focus-ring"
        >
          {copied ? "Copied" : checkout}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <span className="min-w-0 break-all font-mono">
          {detail.baseBranch} ← {detail.headBranch}
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <FileIcon aria-hidden size={16} />
          {detail.changedFiles} files{" "}
          {detail.additions !== undefined && detail.deletions !== undefined && (
            <DiffStat additions={detail.additions} deletions={detail.deletions} />
          )}
        </span>
      </div>
    </header>
  );
}
