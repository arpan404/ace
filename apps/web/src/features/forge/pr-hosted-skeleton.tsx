import type { ForgeKind } from "@ace/protocol";
import { forgeDisplayName } from "@ace/ui-core";
import { StateWords } from "@/components/forge-marks.tsx";
import { useBackLabel } from "@/components/back-label.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { WorkHeading, WorkTitle } from "@/components/work-heading.tsx";
import { reviewNoun } from "./pr-host-words.ts";
import type { PrSeed } from "./pr-page-skeleton.tsx";

/** Description lines, as widths of the column (%). */
const lines = [92, 86, 64];

/**
 * A review on a read-only host while it loads, built like its reader: back, title, the state
 * line, the read-only line, Summary and Code, then the description. What the list row already
 * said shows for real; the rest are placeholders the size of what replaces them.
 */
export function HostedPrSkeleton(props: {
  forge: ForgeKind;
  number: number;
  seed?: PrSeed | undefined;
  onBack?: (() => void) | undefined;
}) {
  const { seed } = props;
  const backLabel = useBackLabel("Pull requests");
  const host = forgeDisplayName(props.forge);
  return (
    <LoadingRegion label={`${reviewNoun(props.forge)} #${props.number}`} className="flex flex-col">
      <header className="px-[var(--forge-gutter,1rem)] pt-4 pb-3">
        <WorkHeading
          back={props.onBack && { label: backLabel, onBack: props.onBack }}
          title={
            seed ? (
              <WorkTitle text={seed.title} number={props.number} />
            ) : (
              <div className="flex h-7 items-center gap-2">
                <Skeleton className="h-5 w-[55%]" />
                <span className="text-xl text-subtle-foreground tabular-nums">#{props.number}</span>
              </div>
            )
          }
          badge={seed ? <StateWords state={seed.state} /> : undefined}
          byline={
            seed ? (
              <span className="text-foreground/85">{seed.author}</span>
            ) : (
              <Skeleton className="h-3 w-64 max-w-[60%]" />
            )
          }
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Read only in Ace. Reviews, comments, checks and merge actions are available on {host}.
        </p>
      </header>
      <div aria-hidden className="border-y border-border py-2">
        <span className="flex items-center gap-0.5 px-[var(--forge-gutter,1rem)]">
          <span className="-ml-2 inline-flex h-7 items-center rounded-md bg-active px-2 text-ui font-medium text-foreground">
            Summary
          </span>
          <span className="inline-flex h-7 items-center rounded-md px-2 text-ui text-muted-foreground">
            Code
          </span>
        </span>
      </div>
      <div aria-hidden className="space-y-2 px-[var(--forge-gutter,1rem)] py-4">
        {lines.map((width) => (
          <Skeleton key={width} className="h-3" style={{ width: `${width}%` }} />
        ))}
      </div>
    </LoadingRegion>
  );
}
