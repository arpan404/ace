import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ForgeBrowserResult, ForgeRepository } from "@ace/protocol";
import { Prose } from "@/components/markdown/prose.tsx";
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
  for (let page = 1; page <= 120; page++) {
    const read = cache.getQueryData<TimelinePage>(timelineKey(project, repository, number, page));
    if (!read) break;
    for (const event of read.events) if (event.kind === "issue_comment") speakers.push(event.actor);
    if (read.nextPage === undefined) break;
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
          <Prose text={props.event.body} className="mt-1 text-ui" />
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

function Page(props: {
  project: string;
  repository: ForgeRepository | undefined;
  number: number;
  page: number;
}) {
  const query = useTimelinePage(props.project, props.repository, props.number, props.page);
  const [more, setMore] = useState(false);
  if (query.isError)
    return (
      <p role="alert" className="flex items-center gap-2 py-3 text-ui text-muted-foreground">
        Couldn't load the conversation.
        <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </p>
    );
  if (!query.data) return props.page === 1 ? <CommentsSkeleton /> : null;
  const page = query.data;
  return (
    <>
      <ul className="flex flex-col">
        {page.events.map((event) => {
          if (event.kind === "issue_comment") return <Comment key={event.id} event={event} />;
          const text = issueEventText(event);
          return text ? <Activity key={event.id} event={event} text={text} /> : null;
        })}
      </ul>
      {page.nextPage !== undefined &&
        (more ? (
          <Page {...props} page={page.nextPage} />
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

/** An issue's comments and activity, oldest first, read a page of 25 at a time. */
export function IssueTimeline(props: {
  project: string;
  repository: ForgeRepository | undefined;
  number: number;
}) {
  return (
    <section aria-label="Conversation" className="mt-6">
      <Page project={props.project} repository={props.repository} number={props.number} page={1} />
    </section>
  );
}
