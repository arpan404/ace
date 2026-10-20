import { useMemo, useState } from "react";
import type { ForgePrDetail } from "@ace/protocol";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import { LongRows } from "@/components/virtual-rows.tsx";
import { QueryState } from "./query-state.tsx";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { composerClearance } from "./pr-composer.tsx";
import { cn } from "@/lib/cn.ts";
import { usePrCommits } from "./pr-commits.tsx";
import { prTimelineItems } from "./pr-timeline.ts";
import { PrTimelineRow, type TimelineExpansion } from "./pr-timeline-rows.tsx";

export function PrActivity(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  order: "newest" | "oldest";
  /** Opens one commit's changes in the Code tab. */
  onOpenCommit?: ((sha: string) => void) | undefined;
}) {
  const ref = props.detail.status.ref;
  const commits = usePrCommits({ ...props, repository: ref.repository });
  const activity = usePrActivityEvents(props);
  const rows = useMemo(
    () =>
      prTimelineItems(
        props.detail,
        commits.data?.commits ?? [],
        activity.data?.events ?? [],
        props.order,
      ),
    [props.detail, commits.data, activity.data, props.order],
  );
  // Lives here, not in the rows, so a virtualized row keeps its state when it remounts.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const expansion = useMemo(
    (): TimelineExpansion => ({
      isOpen: (id) => open.has(id),
      toggle: (id) =>
        setOpen((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
    }),
    [open],
  );
  const settled = !commits.isPending && !activity.isPending;
  return (
    <section
      aria-label="Pull request timeline"
      className={cn("mx-auto w-full max-w-3xl px-4 pt-5", composerClearance)}
    >
      <QueryState query={commits} />
      <QueryState query={activity} />
      {(activity.data?.truncated || commits.data?.truncated) && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          GitHub limits this history to 250 commits and 3,000 timeline events. Open GitHub for the
          complete history.
        </p>
      )}
      {!rows.length ? (
        settled && (
          <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
            <GitPullRequestIcon aria-hidden size={24} className="text-faint-foreground" />
            No activity yet.
          </div>
        )
      ) : (
        <div className="relative before:absolute before:top-4 before:bottom-5 before:left-4 before:w-px before:bg-border">
          <LongRows
            items={rows}
            rowKey={(row) => row.id}
            estimate={48}
            virtualAbove={80}
            render={(row) => (
              <PrTimelineRow item={row} expansion={expansion} onOpenCommit={props.onOpenCommit} />
            )}
          />
        </div>
      )}
    </section>
  );
}
