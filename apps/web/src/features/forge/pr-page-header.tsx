import type { ReactNode } from "react";
import { ArrowSquareOutIcon, FileIcon } from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { StateBadge } from "@/components/forge-marks.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { WorkHeading } from "@/components/work-heading.tsx";
import { openExternal } from "@/boot/open-external.ts";
import type { PrActions } from "./pr-actions.ts";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import { BehindBase, PrPrimaryControl, PrTitle } from "./pr-header.tsx";
import { PrAgentChip } from "./pr-agent-chip.tsx";
import { PrMergeLines } from "./pr-merge-lines.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";

/**
 * A pull request's header on its own page, laid out as an issue's page is (`WorkHeading`): the
 * title in large type with its number, the state badge and who wants to merge what where, then
 * the checkout command, its size and the merge gates.
 */
export function PrPageHeader(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  menu: ReactNode;
  behindOpen: boolean;
  gates: ReactNode;
  onBehindOpen(open: boolean): void;
  onBack?: (() => void) | undefined;
}) {
  const { actions } = props;
  const { context } = actions;
  const { detail } = context;
  const { status } = detail;
  const repository = status.ref.repository;
  const checkout = `gh pr checkout ${status.ref.number} --repo ${repository.host}/${repository.owner}/${repository.name}`;
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy the checkout command" }),
  );
  const commits = `${detail.commits} ${detail.commits === 1 ? "commit" : "commits"}`;
  return (
    <header className="shrink-0 px-[var(--forge-gutter,1rem)] pt-6">
      <WorkHeading
        back={props.onBack && { label: "Pull requests", onBack: props.onBack }}
        title={<PrTitle actions={actions} condensed={false} page />}
        actions={
          <>
            {props.extensions?.headerActions?.(context)}
            <PrAgentChip detail={detail} compact={false} />
            <PrPrimaryControl actions={actions} />
            <IconButton
              size="sm"
              icon={ArrowSquareOutIcon}
              label="Open on GitHub"
              onClick={() =>
                void openExternal(status.url).catch(() =>
                  toast.error({ title: "Couldn't open GitHub" }),
                )
              }
            />
            {props.menu}
          </>
        }
        badge={status.state === "unknown" ? null : <StateBadge kind="pr" state={status.state} />}
        byline={
          <>
            <PrAvatar name={detail.author} url={detail.authorAvatarUrl} />
            <span className="font-medium text-foreground/85">{detail.author}</span>
            <span>
              {status.state === "merged"
                ? `merged ${commits} into`
                : `wants to merge ${commits} into`}
            </span>
            <span className="font-mono text-xs text-foreground/85">{detail.baseBranch}</span>
            <span>from</span>
            <span className="font-mono text-xs text-foreground/85">{detail.headBranch}</span>
            <BehindBase
              actions={actions}
              open={props.behindOpen}
              onOpenChange={props.onBehindOpen}
            />
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
            <PrTime at={detail.updatedAt} prefix="updated " />
          </>
        }
      />
      <div className="mt-3 flex min-w-0 items-center gap-3 pb-3 text-xs text-subtle-foreground">
        <button
          type="button"
          aria-label={copied ? "Checkout command copied" : "Copy checkout command"}
          onClick={() => copy(checkout)}
          title={checkout}
          className="min-w-0 truncate rounded-xs bg-accent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:bg-hover hover:text-foreground"
        >
          {copied ? "Copied" : checkout}
        </button>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 tabular-nums">
          <FileIcon aria-hidden size={12} />
          {detail.changedFiles}
          <span className="sr-only">files</span>
          {detail.additions !== undefined && detail.deletions !== undefined && (
            <DiffStat additions={detail.additions} deletions={detail.deletions} />
          )}
        </span>
      </div>
      <div className="-mx-[var(--forge-gutter,1rem)]">
        {props.gates}
        <PrMergeLines actions={actions} />
      </div>
    </header>
  );
}
