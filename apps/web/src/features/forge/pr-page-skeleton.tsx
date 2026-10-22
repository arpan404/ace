import type { ForgePrRow } from "@ace/protocol";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { StateBadge } from "@/components/forge-marks.tsx";
import { PersonAvatar } from "@/components/person-avatar.tsx";
import { hairlineGrid } from "@/components/ui/rules.ts";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";

/** What a list row already says about the pull request, shown for real while the rest loads. */
export type PrSeed = Pick<
  ForgePrRow,
  "title" | "state" | "author" | "authorAvatarUrl" | "headBranch" | "baseBranch"
> &
  Partial<Pick<ForgePrRow, "additions" | "deletions">>;

const gates = ["Checks", "Reviews", "Conflicts", "Branch"];
const tabs = ["Summary", "Timeline", "Code"];
const files = [
  { path: 46, bar: 64 },
  { path: 38, bar: 44 },
  { path: 52, bar: 36 },
  { path: 30, bar: 28 },
  { path: 42, bar: 20 },
  { path: 34, bar: 14 },
];

/**
 * A pull request's page while it loads, built like the page: back, title, state, author and
 * branches, the checkout command and size, the four merge gates, the tabs, then the Summary's
 * reviewers, changed files and description. Fixed words (gate names, tabs, headings) show for
 * real; what a list row already told us shows for real too; the rest are placeholders the size
 * and shape of what replaces them: pills, avatar circles, file rows with their bars.
 */
export function PrPageSkeleton(props: {
  number: number;
  seed?: PrSeed | undefined;
  onBack?: (() => void) | undefined;
  /** The page's readable column, so the bands line up as on the loaded page. */
  readable?: string | undefined;
}) {
  const { seed } = props;
  const merged = seed?.state === "merged";
  return (
    <LoadingRegion label={`pull request #${props.number}`} className="flex flex-col">
      <div className={props.readable}>
        <header className="px-[var(--forge-gutter,1rem)] pt-6">
          {props.onBack && (
            <div className="mb-2 flex min-h-8 items-center">
              <button
                type="button"
                aria-label="Back to pull requests"
                onClick={props.onBack}
                className="-ml-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground"
              >
                <ArrowLeftIcon aria-hidden size={14} />
                Pull requests
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
                <span className="font-medium text-foreground/85">{seed.author}</span>
                {seed.baseBranch && seed.headBranch ? (
                  <>
                    <span>{merged ? "merged into" : "wants to merge into"}</span>
                    <span className="font-mono text-xs text-foreground/85">{seed.baseBranch}</span>
                    <span>from</span>
                    <span className="font-mono text-xs text-foreground/85">{seed.headBranch}</span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-64" />
              </>
            )}
          </div>
          <div className="mt-3 flex min-w-0 items-center gap-3 pb-3">
            <Skeleton className="h-5 w-80 max-w-[60%] rounded-xs" />
            <span className="ml-auto text-xs tabular-nums">
              {seed?.additions !== undefined && seed.deletions !== undefined ? (
                <DiffStat additions={seed.additions} deletions={seed.deletions} />
              ) : (
                <Skeleton className="h-3 w-24" />
              )}
            </span>
          </div>
        </header>
        <div
          aria-hidden
          className={cn(
            hairlineGrid,
            "grid-cols-4 border-t border-border @max-[30rem]/pr:grid-cols-2",
          )}
        >
          {gates.map((gate) => (
            <span
              key={gate}
              className="flex flex-col gap-0.5 bg-panel py-2 pr-2 pl-4 first:pl-[var(--forge-gutter,1rem)]"
            >
              <span className="text-meta text-subtle-foreground">{gate}</span>
              <span className="flex h-4 items-center gap-1.5">
                <Skeleton className="size-1.5 rounded-full" />
                <Skeleton className="h-3 w-16" />
              </span>
            </span>
          ))}
        </div>
      </div>
      <div aria-hidden className="border-y border-border py-2">
        <div className={cn("flex items-center px-[var(--forge-gutter,1rem)]", props.readable)}>
          <span className="-ml-2 flex items-center gap-0.5">
            {tabs.map((tab, index) => (
              <span
                key={tab}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-2 text-ui text-muted-foreground",
                  index === 0 && "bg-active font-medium text-foreground",
                )}
              >
                {tab}
              </span>
            ))}
          </span>
        </div>
      </div>
      <div aria-hidden className={props.readable}>
        <div className="space-y-3 px-[var(--forge-gutter,1rem)] pt-2">
          <div className="flex min-h-8 items-center gap-1.5">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <section className="space-y-1.5">
            <h3 className="flex h-8 items-center text-xs font-medium text-muted-foreground">
              Changes
            </h3>
            <ul>
              {files.map((file) => (
                <li key={`${file.path}-${file.bar}`} className="flex h-7 items-center gap-3">
                  <Skeleton className="h-3" style={{ width: `${file.path}%` }} />
                  <Skeleton
                    className="ml-auto h-1.5 rounded-full @max-[30rem]/pr:hidden"
                    style={{ width: file.bar }}
                  />
                  <Skeleton className="h-3 w-20" />
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-1.5">
            <h3 className="flex h-8 items-center text-xs font-medium text-muted-foreground">
              Description
            </h3>
            <div className="flex flex-col gap-2 pt-1">
              <Skeleton className="h-3 w-[92%]" />
              <Skeleton className="h-3 w-[86%]" />
              <Skeleton className="h-3 w-[48%]" />
            </div>
          </section>
        </div>
      </div>
    </LoadingRegion>
  );
}
