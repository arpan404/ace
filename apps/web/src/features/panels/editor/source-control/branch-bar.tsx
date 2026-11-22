import { ArrowDownIcon, ArrowUpIcon, ArrowsClockwiseIcon, GitBranchIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * The branch line of Source control: the checkout's branch (read-only), how far the remote is
 * ahead, Push with how many commits it sends, and Fetch. Every action is a bare icon with a tip.
 */
export function BranchBar(props: {
  branch: string | null;
  ahead: number;
  behind: number;
  disabled: boolean;
  pendingAction: string | undefined;
  onPush(): void;
  onFetch(): void;
}) {
  const busy = props.disabled || props.pendingAction !== undefined;
  const branchLabel = props.branch ?? "Detached HEAD";
  return (
    <div
      data-part="source-control-branch-bar"
      className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
    >
      <Tip label={props.branch ? `On ${props.branch}` : "Not on a branch"}>
        <span
          aria-label={`Branch: ${branchLabel}`}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 px-1.5 text-xs font-medium text-foreground"
        >
          <Icon icon={GitBranchIcon} size={13} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{branchLabel}</span>
        </span>
      </Tip>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.behind > 0 && (
          <Tip label={`${props.behind} new on the remote`}>
            <span
              aria-label={`${props.behind} behind`}
              className="inline-flex h-6 items-center gap-0.5 px-1 text-muted-foreground"
            >
              <Icon icon={ArrowDownIcon} size={14} />
              <span className="font-mono text-[11px] leading-none tabular-nums">
                {props.behind}
              </span>
            </span>
          </Tip>
        )}
        <Tip label={props.ahead > 0 ? `Push (${props.ahead} ahead)` : "Push"}>
          <button
            type="button"
            aria-label={props.ahead > 0 ? `Push (${props.ahead} ahead)` : "Push"}
            disabled={busy}
            onClick={props.onPush}
            className={cn(
              "inline-flex h-6 items-center gap-0.5 rounded-sm px-1 text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-40",
              props.ahead === 0 && "w-6 justify-center px-0",
              props.pendingAction === "push" && "[&_svg]:animate-pulse",
            )}
          >
            <Icon icon={ArrowUpIcon} size={14} />
            {props.ahead > 0 && (
              <span className="font-mono text-[11px] leading-none tabular-nums">{props.ahead}</span>
            )}
          </button>
        </Tip>
        <IconButton
          icon={ArrowsClockwiseIcon}
          label="Fetch"
          size="sm"
          disabled={busy}
          onClick={props.onFetch}
          className={cn(
            "size-6 rounded-sm hover:bg-hover",
            props.pendingAction === "fetch" && "[&_svg]:animate-spin",
          )}
        />
      </div>
    </div>
  );
}
