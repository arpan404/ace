import type { ForgeIssueRow } from "@ace/protocol";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { StateBadge } from "@/components/forge-marks.tsx";
import { PersonAvatar } from "@/components/person-avatar.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";

/** Comments while an issue's conversation loads: avatar, name and age, then their lines. */
export function CommentsSkeleton(props: { count?: number }) {
  const widths = [
    ["88%", "64%"],
    ["72%", "90%", "40%"],
  ];
  return (
    <ul aria-hidden className="flex flex-col">
      {Array.from({ length: props.count ?? 2 }, (_, index) => (
        <li key={index} className="flex gap-3 border-t border-border py-4 first:border-t-0">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <span className="flex items-center gap-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-8" />
            </span>
            {(widths[index % widths.length] ?? []).map((width) => (
              <Skeleton key={width} className="h-3" style={{ width }} />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * An issue's page while it loads, built like the page: back, title, state and author, then the
 * description and the conversation. What the list's row already says shows for real.
 */
export function IssuePageSkeleton(props: {
  number: number;
  seed?: Pick<ForgeIssueRow, "title" | "state" | "author" | "authorAvatarUrl"> | undefined;
  /** The list Back returns to: "Issues", or "Inbox" when opened from there. */
  backLabel: string;
  onBack(): void;
  /** The page's readable column and gutter. */
  readable: string;
}) {
  const { seed } = props;
  return (
    <LoadingRegion label={`issue #${props.number}`} className={`${props.readable} pt-6 pb-16`}>
      <div className="mb-2 flex min-h-8 items-center">
        <button
          type="button"
          aria-label={`Back to ${props.backLabel.toLowerCase()}`}
          onClick={props.onBack}
          className="-ml-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden size={14} />
          {props.backLabel}
        </button>
      </div>
      {seed ? (
        <h2 className="min-w-0 text-xl font-semibold tracking-title text-foreground">
          {seed.title}{" "}
          <span className="font-normal text-subtle-foreground tabular-nums">#{props.number}</span>
        </h2>
      ) : (
        <div className="flex h-7 items-center gap-2">
          <Skeleton className="h-5 w-[55%]" />
          <span className="text-xl text-subtle-foreground tabular-nums">#{props.number}</span>
        </div>
      )}
      <div className="mt-2 flex min-h-6 items-center gap-x-1.5 text-ui text-muted-foreground">
        {seed ? (
          <>
            <StateBadge kind="issue" state={seed.state} />
            <PersonAvatar name={seed.author} url={seed.authorAvatarUrl} />
            <span className="font-medium text-foreground/85">{seed.author}</span>
            <span>opened</span>
          </>
        ) : (
          <>
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
          </>
        )}
      </div>
      <div aria-hidden className="mt-6 flex flex-col gap-2 border-t border-border pt-5">
        <Skeleton className="h-3 w-[94%]" />
        <Skeleton className="h-3 w-[88%]" />
        <Skeleton className="h-3 w-[91%]" />
        <Skeleton className="h-3 w-[52%]" />
      </div>
      <div className="mt-6">
        <CommentsSkeleton />
      </div>
    </LoadingRegion>
  );
}
