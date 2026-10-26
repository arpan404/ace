import { useMemo, useState } from "react";
import type { ForgePrDetail } from "@ace/protocol";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import { LongRows } from "@/components/virtual-rows.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { QueryState } from "./query-state.tsx";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { PrConversationBox } from "./pr-conversation-box.tsx";
import { cn } from "@/lib/cn.ts";
import { usePrCommits } from "./pr-commits.tsx";
import { prTimelineItems } from "@ace/ui-core";
import { PrTimelineRow, type TimelineExpansion } from "./pr-timeline-rows.tsx";

export function PrActivity(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  order: "newest" | "oldest";
  /** Opens one commit's changes in the Code tab. */
  onOpenCommit?: ((sha: string) => void) | undefined;
  className?: string | undefined;
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
  // Older pages are still on their way; a failed read says so through its own state.
  const arriving =
    (commits.data?.complete === false && !commits.error) ||
    (activity.data?.complete === false && !activity.error);
  const older = arriving && <ListSkeleton label="older history" shape="row" rows={2} />;
  return (
    <section
      aria-label="Pull request timeline"
      className={cn(
        "mx-auto w-full max-w-3xl px-[var(--forge-gutter,1rem)] pt-5 pb-10",
        props.className,
      )}
    >
      <QueryState label="commits" query={commits} />
      <QueryState label="timeline" query={activity} />
      {(activity.data?.truncated || commits.data?.truncated) && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          This history is longer than ace reads at once, so some older entries are left out.
        </p>
      )}
      {props.order === "oldest" && older}
      {/* The comment box sits at the newest end, where what it posts appears. */}
      {props.order === "newest" && <PrConversationBox />}
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
      {props.order === "oldest" && <PrConversationBox />}
      {props.order === "newest" && older}
    </section>
  );
}
