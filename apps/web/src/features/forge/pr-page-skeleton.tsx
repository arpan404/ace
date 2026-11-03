import type { ForgePrRow } from "@ace/protocol";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { StateWords } from "@/components/forge-marks.tsx";
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
/** The facts line's four facts, as placeholder widths (px). */
const facts = [120, 132, 80, 128];
/** Two blockers, their quotes as widths of the column (%). */
const blockers = [82, 64];
const about = ["Reviewers", "Assignee", "Labels"];

/**
 * A pull request's page while it loads, built like the page: back, title, the state line
 * (state in words, author and branches), the facts line, the tabs, then the Summary's
 * Blocking the merge, About and description. Fixed words (tabs, headings) show for real; what a
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
  // Only an open PR has a facts line and blockers; with no seed, the likely case is open.
  const open = !seed || seed.state === "open" || seed.state === "draft";
  return (
    <LoadingRegion label={`pull request #${props.number}`} className="flex flex-col">
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
                <StateWords state={seed.state} />
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <PersonAvatar name={seed.author} url={seed.authorAvatarUrl} />
                <span className="text-foreground/85">{seed.author}</span>
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
                <Skeleton className="h-3 w-12" />
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-64 max-w-[60%]" />
              </>
            )}
          </div>
          {open && (
            // The facts line: checks, reviews, conflicts, branch, as words between dots.
            <div aria-hidden className="mt-2.5 flex h-6 items-center gap-x-2">
              {facts.map((width, index) => (
                <span key={width} className="inline-flex items-center gap-x-2">
                  {index > 0 && <span className="text-xs text-faint-foreground">·</span>}
                  <Skeleton className="h-3" style={{ width }} />
                </span>
              ))}
            </div>
          )}
        </header>
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
          {open && (
            <section className="space-y-1.5">
              <h3 className="flex h-8 items-center text-xs font-medium text-muted-foreground">
                Blocking the merge
              </h3>
              <ul className="divide-y divide-border-soft">
                {blockers.map((width) => (
                  <li key={width} className="flex gap-2.5 py-2.5">
                    <Skeleton className="size-5 shrink-0 rounded-full" />
                    <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-3" style={{ width: `${width}%` }} />
                      <Skeleton className="h-2.5 w-48" />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="space-y-1.5">
            <h3 className="flex h-8 items-center text-xs font-medium text-muted-foreground">
              About
            </h3>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2.5 text-ui">
              {about.map((term) => (
                <div key={term} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="flex h-5 items-center gap-1.5">
                    <Skeleton className="size-4 rounded-full" />
                    <Skeleton className="h-3 w-28" />
                  </dd>
                </div>
              ))}
            </dl>
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
