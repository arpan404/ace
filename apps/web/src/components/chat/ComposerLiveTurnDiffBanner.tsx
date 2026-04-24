import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "../ui/button";

function formatDiffCount(value: number) {
  return value.toLocaleString();
}

function hasNonZeroStat(stat: { additions: number; deletions: number }) {
  return stat.additions > 0 || stat.deletions > 0;
}

export function ComposerLiveTurnDiffBanner(props: {
  additions: number;
  deletions: number;
  fileCount: number;
  onReviewChanges: () => void;
}) {
  if (!hasNonZeroStat({ additions: props.additions, deletions: props.deletions })) {
    return null;
  }

  return (
    <div
      className="mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 shadow-sm"
      data-testid="composer-live-turn-diff-banner"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium tabular-nums">
        <span className="text-success">+{formatDiffCount(props.additions)}</span>
        <span className="text-destructive">-{formatDiffCount(props.deletions)}</span>
        <span className="text-foreground/55">
          in {formatDiffCount(props.fileCount)} {props.fileCount === 1 ? "file" : "files"}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-sm font-medium text-foreground/68 transition-opacity hover:bg-transparent hover:text-foreground/92"
        onClick={props.onReviewChanges}
      >
        <span>Review changes</span>
        <ArrowUpRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}
