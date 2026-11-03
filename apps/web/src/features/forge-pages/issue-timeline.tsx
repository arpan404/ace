import { useCallback, useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ForgeBrowserResult, ForgeRepository } from "@ace/protocol";
import { ForgeProse } from "@/features/forge/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { PersonAvatar as PrAvatar, RelativeTime as PrTime } from "@/components/person-avatar.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { issueEventText } from "./issue-events.ts";
import { CommentsSkeleton } from "./issue-skeletons.tsx";
import { WebLink } from "@/components/web-link.tsx";

type TimelinePage = Extract<ForgeBrowserResult, { resource: "issueTimeline" }>;
type IssueEvent = TimelinePage["events"][number];

const timelineKey = (
  project: string,
  repository: ForgeRepository | undefined,
  number: number,
  page: number,
) => [
  "forge",
  project,
  "browse",
  "issueTimeline",
  number,
  page,
  repository ? repositoryParam(repository) : "",
];

/**
 * Who has spoken in the issue so far, oldest first, from every page of its conversation this
 * device has read: what the page shows, read when asked rather than on every render.
 */
export function timelineSpeakers(
  cache: QueryClient,
  project: string,
  repository: ForgeRepository | undefined,
  number: number,
): string[] {
  const speakers: string[] = [];
  // Page by page as the conversation links them, at most as many as GitHub lists.
  let page: number | undefined = 1;
  for (let read = 0; page !== undefined && read < 120; read++) {
    const answer: TimelinePage | undefined = cache.getQueryData<TimelinePage>(
      timelineKey(project, repository, number, page),
    );
    if (!answer) break;
    for (const event of answer.events)
      if (event.kind === "issue_comment") speakers.push(event.actor);
    page = answer.nextPage;
  }
  return speakers;
}

/** One page of an issue's conversation, oldest first. */
function useTimelinePage(
  project: string,
  repository: ForgeRepository | undefined,
  number: number,
  page: number,
) {
  return useDaemonQuery<TimelinePage>({
    queryKey: timelineKey(project, repository, number, page),
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    retry: false,
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.issue.timeline",
          workspaceId: project,
          number,
          page,
          ...(repository ? { repository } : {}),
        },
        signal,
      );
      if (value.resource !== "issueTimeline") throw new Error("No timeline.");
      return value;
    },
  });
}

function Comment(props: { event: IssueEvent }) {
  return (
    <li className="flex gap-3 border-t border-border py-4 first:border-t-0">
      <PrAvatar name={props.event.actor} className="size-6 min-w-6 self-start" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-ui">
          <span className="font-medium text-foreground">{props.event.actor}</span>
          <PrTime at={props.event.at} />
        </p>
        {props.event.body?.trim() ? (
          <ForgeProse text={props.event.body} className="mt-1 text-ui" />
        ) : null}
      </div>
    </li>
  );
}

function Activity(props: { event: IssueEvent; text: string }) {
  return (
    <li className="flex items-baseline gap-1.5 border-t border-border py-2 pl-9 text-ui text-muted-foreground first:border-t-0">
      <span className="font-medium text-foreground/85">{props.event.actor}</span>
      {props.event.pullRequestUrl ? (
        <WebLink href={props.event.pullRequestUrl} className="text-link hover:underline focus-ring">
          {props.text}
        </WebLink>
      ) : (
        <span>{props.text}</span>
      )}
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <PrTime at={props.event.at} />
    </li>
  );
}

interface PageProps {
  project: string;
  repository: ForgeRepository | undefined;
  number: number;
  page: number;
}

function Events(props: { page: TimelinePage }) {
  return (
    <ul className="flex flex-col">
      {props.page.events.map((event) => {
        if (event.kind === "issue_comment") return <Comment key={event.id} event={event} />;
        const text = issueEventText(event);
        return text ? <Activity key={event.id} event={event} text={text} /> : null;
      })}
    </ul>
  );
}

function Failed(props: { retry(): void }) {
  return (
    <p role="alert" className="flex items-center gap-2 py-3 text-ui text-muted-foreground">
      Couldn't load the conversation.
      <Button size="xs" variant="ghost" onClick={props.retry}>
        Try again
      </Button>
    </p>
  );
}

const commentsOn = (page: TimelinePage | undefined) =>
  page?.events.filter((event) => event.kind === "issue_comment").length ?? 0;

/** One page, read when shown; it says how many comments it holds once read. */
function Page(props: PageProps & { onComments(page: number, count: number): void }) {
  const query = useTimelinePage(props.project, props.repository, props.number, props.page);
  const count = query.data ? commentsOn(query.data) : undefined;
  const { onComments, page } = props;
  useEffect(() => {
    if (count !== undefined) onComments(page, count);
  }, [onComments, page, count]);
  if (query.isError) return <Failed retry={() => void query.refetch()} />;
  if (!query.data) return <CommentsSkeleton />;
  return <Events page={query.data} />;
}

/** A conversation from a daemon that doesn't name its last page: read forward, oldest first. */
function Forward(props: PageProps & { first: TimelinePage }) {
  const [more, setMore] = useState(false);
  const next = props.first.nextPage;
  return (
    <>
      <Events page={props.first} />
      {next !== undefined &&
        (more ? (
          <ForwardPage {...props} page={next} />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 text-muted-foreground"
            onClick={() => setMore(true)}
          >
            Show more activity
          </Button>
        ))}
    </>
  );
}

function ForwardPage(props: PageProps) {
  const query = useTimelinePage(props.project, props.repository, props.number, props.page);
  if (query.isError) return <Failed retry={() => void query.refetch()} />;
  if (!query.data) return null;
  return <Forward {...props} first={query.data} />;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * An issue's comments and activity, oldest at the top as a conversation reads, opened at its end:
 * the newest page of 25 (and the one before when that's short), with earlier pages read on
 * request from above. `comments` is the issue's comment count, for saying how many are hidden.
 */
export function IssueTimeline(props: {
  project: string;
  repository: ForgeRepository | undefined;
  number: number;
  comments?: number | undefined;
}) {
  const { project, repository, number } = props;
  const first = useTimelinePage(project, repository, number, 1);
  const last = first.data ? (first.data.lastPage ?? (first.data.nextPage ? 0 : 1)) : 1;
  const end = useTimelinePage(project, repository, number, Math.max(1, last));
  // Pages the person asked to see before the newest ones; 0 until they ask.
  const [earlier, setEarlier] = useState(0);
  const short = (end.data?.events.length ?? 25) < 10;
  const from = Math.max(1, last - (short ? 1 : 0) - earlier);
  const pages = Array.from({ length: Math.max(0, last - from + 1) }, (_, index) => from + index);
  // Comments on each page shown, as each reports once read.
  const [counts, setCounts] = useState<ReadonlyMap<number, number>>(new Map());
  const onComments = useCallback(
    (page: number, count: number) =>
      setCounts((known) => (known.get(page) === count ? known : new Map(known).set(page, count))),
    [],
  );
  let shown = 0;
  for (const page of pages) shown += counts.get(page) ?? 0;
  const hidden = props.comments === undefined ? 0 : Math.max(0, props.comments - shown);
  if (first.isError) return <Failed retry={() => void first.refetch()} />;
  if (!first.data) return <CommentsSkeleton />;
  if (last === 0)
    return (
      <section aria-label="Conversation" className="mt-6">
        <Forward
          project={project}
          repository={repository}
          number={number}
          page={1}
          first={first.data}
        />
      </section>
    );
  return (
    <section aria-label="Conversation" className="mt-6">
      {from > 1 && (
        <Button
          size="sm"
          variant="ghost"
          className="mb-1 text-muted-foreground"
          onClick={() => setEarlier((count) => count + 1)}
        >
          {hidden > 0 ? `Show ${plural(hidden, "earlier comment")}` : "Show earlier activity"}
        </Button>
      )}
      {pages.map((page) => (
        <Page
          key={page}
          project={project}
          repository={repository}
          number={number}
          page={page}
          onComments={onComments}
        />
      ))}
    </section>
  );
}
