import { useMemo } from "react";
import type { ForgePrDetail } from "@ace/protocol";
import {
  GitCommitIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  TagIcon,
  UsersIcon,
  ChatCircleIcon,
  ArrowsClockwiseIcon,
} from "@phosphor-icons/react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { LongRows } from "@/components/virtual-rows.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";
import { usePrCommits } from "./pr-commits.tsx";
import { eventText, prTimeline } from "./pr-timeline.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";

export function PrActivity(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  order: "newest" | "oldest";
}) {
  const ref = props.detail.status.ref;
  const commits = usePrCommits({ ...props, repository: ref.repository });
  const activity = useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      ref,
      "workspace-activity",
      props.detail.updatedAt,
      props.detail.status.headSha,
    ],
    retry: false,
    read: async (client, signal) => {
      const events: import("@ace/protocol/forge-browser").ForgeActivity[] = [];
      let page: number | undefined = 1;
      let truncated = false;
      while (page !== undefined) {
        const result = await readForge(
          client,
          {
            op: "forge.pr.activity",
            workspaceId: props.workspaceId,
            repository: ref.repository,
            number: ref.number,
            page,
          },
          signal,
        );
        if (result.resource !== "prActivity") throw new Error("No activity response.");
        events.push(...result.events);
        truncated ||= result.truncated;
        page =
          result.nextPage && result.nextPage > page && result.nextPage <= 120
            ? result.nextPage
            : undefined;
      }
      return { events, truncated };
    },
  });
  const rows = useMemo(
    () =>
      prTimeline(
        props.detail,
        commits.data?.commits ?? [],
        activity.data?.events ?? [],
        props.order,
      ),
    [props.detail, commits.data, activity.data, props.order],
  );
  return (
    <section aria-label="Pull request timeline" className="px-4 py-3">
      <QueryState query={commits} />
      <QueryState query={activity} />
      {(activity.data?.truncated || commits.data?.truncated) && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          GitHub limits this history to 250 commits and 3,000 timeline events. Open GitHub for the
          complete history.
        </p>
      )}
      {!rows.length && <p className="text-sm text-muted-foreground">No activity yet.</p>}
      <LongRows
        items={rows}
        rowKey={(row) => row.id}
        estimate={64}
        virtualAbove={80}
        render={(row) => {
          const event = row.kind === "event" ? row.event : undefined;
          const Icon =
            event?.event === "merged"
              ? GitMergeIcon
              : event?.event.includes("label")
                ? TagIcon
                : event?.event.includes("review_request")
                  ? UsersIcon
                  : event?.event.includes("force_push")
                    ? ArrowsClockwiseIcon
                    : event?.event === "reviewed"
                      ? ChatCircleIcon
                      : event?.event === "committed"
                        ? GitCommitIcon
                        : GitPullRequestIcon;
          return (
            <div className="relative flex gap-3 pb-4 pl-2 before:absolute before:top-6 before:bottom-0 before:left-4.5 before:w-px before:bg-border">
              <div className="relative z-[1] flex size-5 shrink-0 items-center justify-center bg-panel">
                {row.kind === "commit" ? (
                  <PrAvatar name={row.commit.author} url={row.commit.authorAvatarUrl} />
                ) : row.kind === "comment" ? (
                  <PrAvatar name={row.comment.author} url={row.comment.authorAvatarUrl} />
                ) : (
                  <Icon aria-hidden size={16} className="text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                {row.kind === "commit" ? (
                  <>
                    <p className="text-ui font-medium">{row.commit.message.split("\n")[0]}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <a
                        href={row.commit.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-mono hover:underline focus-ring"
                      >
                        {row.commit.sha.slice(0, 7)}
                      </a>
                      <PrTime at={row.at} />
                      <span>{row.commit.author}</span>
                    </div>
                  </>
                ) : row.kind === "comment" ? (
                  <>
                    <p className="text-ui">
                      <span className="font-medium">{row.comment.author}</span>{" "}
                      {row.comment.kind === "review"
                        ? `submitted a review: ${row.comment.reviewState ?? "unknown"}`
                        : "commented"}
                    </p>
                    <PrTime at={row.at} />
                    <Prose text={row.comment.body} className="text-ui leading-normal" />
                  </>
                ) : (
                  <>
                    <p className="text-ui">
                      <span className="font-medium">{row.event.actor}</span> {eventText(row.event)}
                    </p>
                    <PrTime at={row.at} />
                  </>
                )}
              </div>
              {row.kind === "commit" &&
                row.commit.additions !== undefined &&
                row.commit.deletions !== undefined && (
                  <DiffStat
                    className="shrink-0 self-start text-xs"
                    additions={row.commit.additions}
                    deletions={row.commit.deletions}
                  />
                )}
            </div>
          );
        }}
      />
    </section>
  );
}
