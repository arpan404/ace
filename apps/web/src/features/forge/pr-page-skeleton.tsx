import type { ForgePrRow } from "@ace/protocol";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { StateBadge } from "@/components/forge-marks.tsx";
import { PersonAvatar } from "@/components/person-avatar.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useBackLabel } from "@/components/back-label.tsx";

/** What a list row already says about the pull request, shown for real while the rest loads. */
export type PrSeed = Pick<
  ForgePrRow,
  "title" | "state" | "author" | "authorAvatarUrl" | "headBranch" | "baseBranch"
> &
  Partial<Pick<ForgePrRow, "additions" | "deletions">>;

const tabs = ["Summary", "Timeline", "Code", "Checks"];
/** A branch name, as the loaded header sets it. */
const branch =
  "rounded-md bg-[color-mix(in_oklab,var(--color-link)_12%,transparent)] px-1.5 py-px font-mono text-xs text-link";
/** Two blockers, their quotes as widths of the column (%). */
const blockers = [82, 64];
const about = ["Reviewers", "Assignee", "Labels"];

/**
 * A pull request's page while it loads, built like the page: back, title, the state line
 * (state pill, author and branches), the tabs, then the Summary's description and merge box
 * beside the sidebar. Fixed words (tabs, headings) show for real; what a
 * list row already told us shows for real too; the rest are placeholders the size and shape of
 * what replaces them.
 */
export function PrPageSkeleton(props: {
  number: number;
  seed?: PrSeed | undefined;
  onBack?: (() => void) | undefined;
  /** The page's readable column, so the bands line up as on the loaded page. */
  readable?: string | undefined;
}) {
  const { seed } = props;
  const backLabel = useBackLabel("Pull requests");
  const merged = seed?.state === "merged";
  // Only an open PR has blockers; with no seed, the likely case is open.
  const open = !seed || seed.state === "open" || seed.state === "draft";
  return (
    <LoadingRegion label={`pull request #${props.number}`} className="@container/pr flex flex-col">
      <div className={props.readable}>
        <header className="px-[var(--forge-gutter,1rem)] pt-4 pb-3">
          {props.onBack && (
            <div className="mb-2 flex min-h-8 items-center">
              <button
                type="button"
                aria-label={`Back to ${backLabel.toLowerCase()}`}
                onClick={props.onBack}
                className="-ml-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground"
              >
                <ArrowLeftIcon aria-hidden size={14} />
                {backLabel}
              </button>
            </div>
          )}
          {seed ? (
            <h2 className="min-w-0 text-xl font-semibold tracking-title text-foreground">
              {seed.title}{" "}
              <span className="font-normal text-subtle-foreground tabular-nums">
                #{props.number}
              </span>
            </h2>
          ) : (
            <div className="flex h-7 items-center gap-2">
              <Skeleton className="h-5 w-[55%]" />
              <span className="text-xl text-subtle-foreground tabular-nums">#{props.number}</span>
            </div>
          )}
          <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-muted-foreground">
            {seed ? (
              <>
                <StateBadge kind="pr" state={seed.state} />
                <PersonAvatar name={seed.author} url={seed.authorAvatarUrl} />
                <span className="font-semibold text-foreground/90">{seed.author}</span>
                {seed.baseBranch && seed.headBranch ? (
                  <>
                    <span>{merged ? "merged into" : "wants to merge into"}</span>
                    <span className={branch}>{seed.baseBranch}</span>
                    <span>from</span>
                    <span className={branch}>{seed.headBranch}</span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-64 max-w-[60%]" />
              </>
            )}
          </div>
        </header>
      </div>
      <div aria-hidden className="border-b border-border">
        <div className={cn("flex items-center px-[var(--forge-gutter,1rem)]", props.readable)}>
          <span className="-ml-2 flex items-center gap-1">
            {tabs.map((tab, index) => (
              <span
                key={tab}
                className={cn(
                  "relative inline-flex h-10 items-center px-2 text-ui text-muted-foreground",
                  index === 0 &&
                    "font-medium text-foreground before:absolute before:inset-x-1 before:-bottom-px before:h-0.5 before:rounded-full before:bg-foreground",
                )}
              >
                {tab}
              </span>
            ))}
          </span>
        </div>
      </div>
      <div aria-hidden className={props.readable}>
        <div className="grid gap-6 px-[var(--forge-gutter,1rem)] pt-4 @min-[50rem]/pr:grid-cols-[minmax(0,1fr)_15rem] @min-[50rem]/pr:gap-8">
          <div className="min-w-0 space-y-5">
            <section className="overflow-hidden rounded-lg border border-border">
              <div className="flex min-h-10 items-center gap-2 border-b border-border bg-muted px-3">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-40" />
              </div>
              <div className="flex flex-col gap-2 px-4 py-3.5">
                <Skeleton className="h-3 w-[92%]" />
                <Skeleton className="h-3 w-[86%]" />
                <Skeleton className="h-3 w-[48%]" />
              </div>
            </section>
            <section className="overflow-hidden rounded-lg border border-border">
              <ul className="divide-y divide-border-soft">
                {(open ? blockers : [70]).map((width) => (
                  <li key={width} className="flex gap-3 px-4 py-3">
                    <Skeleton className="size-6 shrink-0 rounded-full" />
                    <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-3" style={{ width: `${width}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className="min-w-0 @min-[50rem]/pr:pt-1">
            {about.map((term) => (
              <div
                key={term}
                className="border-b border-border-soft py-3 first:pt-0 last:border-b-0"
              >
                <p className="flex h-6 items-center text-xs font-semibold text-muted-foreground">
                  {term}
                </p>
                <div className="mt-0.5 flex h-6 items-center gap-1.5">
                  <Skeleton className="size-4 rounded-full" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
