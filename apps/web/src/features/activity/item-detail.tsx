import {
  useConnectionState,
  useInteraction,
  useThreadError,
  useThreadMeta,
} from "@ace/client-react";
import { CheckCircleIcon, TrayIcon, XCircleIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { AutomationRunDetail, useAutomationRuns } from "@/features/automations/index.ts";
import { Page } from "@/features/shell/index.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { useActivityState } from "./activity-state.tsx";
import { ButtonKey, CardActions } from "./card-frame.tsx";
import type { FeedDetail, FeedEvent, PrRef } from "./feed-events.ts";
import { useFeed } from "./feed-source.ts";
import { InteractionCard } from "./interaction-card.tsx";
import { MentionReply } from "./mention-reply.tsx";

// The comment renderer (marked) loads only when a mention is opened.
const Markdown = lazy(() =>
  import("@/components/markdown/markdown.tsx").then((module) => ({ default: module.Markdown })),
);

/**
 * One Activity item on its own (`/activity?item=`): a request or decision as its card, a
 * mention with the whole comment, failing checks, a pull request's end, or an automation run.
 */
export function ItemDetail(props: { itemKey: string }) {
  const { itemKey } = props;
  const { focusCard } = useActivityState();
  // A card shown on its own takes the card keys (A, D, 1–3, O).
  useEffect(() => focusCard(itemKey), [focusCard, itemKey]);
  if (itemKey.startsWith("interaction:")) {
    const [, threadId = "", interactionId = ""] = itemKey.split(":");
    return (
      <RequestDetailRetry threadId={threadId} interactionId={interactionId} itemKey={itemKey} />
    );
  }
  return <FeedDetailPage itemKey={itemKey} />;
}

/** A failed thread read is tried again by reading the thread afresh. */
function RequestDetailRetry(props: { threadId: string; interactionId: string; itemKey: string }) {
  const [attempt, setAttempt] = useState(0);
  return <RequestDetail key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function RequestDetail(props: {
  threadId: string;
  interactionId: string;
  itemKey: string;
  onRetry(): void;
}) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const thread = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const ready = useConnectionState() === "ready";
  if (interaction === undefined) {
    if (error?.code === "daemon" && error.message === "not_found")
      return <Gone title="This thread is gone" />;
    if (error) return <Unavailable onRetry={props.onRetry} />;
    // The thread has loaded and has no such request: the link is stale.
    if (thread) return <Gone title="This request is no longer open" />;
    return ready ? <DetailLoading /> : <Unavailable />;
  }
  if (interaction.state !== "pending") return <Gone title="This request was answered" />;
  return (
    <Page>
      <InteractionCard
        threadId={props.threadId}
        interactionId={props.interactionId}
        cardKey={props.itemKey}
      />
    </Page>
  );
}

function FeedDetailPage(props: { itemKey: string }) {
  const feed = useFeed();
  const runs = useAutomationRuns();
  const ready = useConnectionState() === "ready";
  const { itemKey } = props;
  if (itemKey.startsWith("run:")) {
    const id = itemKey.slice("run:".length);
    const run = feed.runs?.find((candidate) => candidate.id === id);
    if (run)
      return (
        <Page>
          <AutomationRunDetail run={run} />
        </Page>
      );
    if (runs.isError) return <Unavailable onRetry={() => void runs.refetch()} />;
    if (feed.runs !== undefined) return <Gone title="This run is no longer listed" />;
    return ready ? <DetailLoading /> : <Unavailable />;
  }
  const id = itemKey.slice("event:".length);
  const event = feed.events.find((candidate) => candidate.id === id);
  if (!event) {
    if (feed.eventsFailed) return <Unavailable onRetry={feed.retryEvents} />;
    if (feed.eventsSettled) return <Gone title="This item is no longer in Activity" />;
    return ready ? <DetailLoading /> : <Unavailable />;
  }
  return <EventDetail event={event} />;
}

function DetailLoading() {
  return (
    <Page>
      <LoadingRegion label="item" className="flex flex-col gap-3">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-6 w-72" />
        <SkeletonText lines={4} className="mt-6" />
      </LoadingRegion>
    </Page>
  );
}

/** Not readable now: offline, or the daemon didn't answer. */
function Unavailable(props: { onRetry?: () => void }) {
  return (
    <EmptyState
      icon={TrayIcon}
      title="Couldn't load this item"
      description={
        props.onRetry
          ? "ace didn't answer."
          : "Not connected to ace. It loads once the connection is back."
      }
      action={
        props.onRetry ? (
          <Button size="sm" onClick={props.onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

function Gone(props: { title: string }) {
  return (
    <EmptyState
      icon={TrayIcon}
      title={props.title}
      action={
        <Link to="/activity" className={buttonVariants({ size: "sm" })}>
          Back to Activity
        </Link>
      }
    />
  );
}

/** The frame of an item's page: context line, title, then its body and actions. */
function DetailFrame(props: { context: string; at: number; title: string; children: ReactNode }) {
  const now = useNow();
  return (
    <Page>
      <article aria-label={props.title}>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="min-w-0 truncate">{props.context}</span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(props.at).toISOString()} className="shrink-0 tabular-nums">
            {formatAge(props.at, now)}
          </time>
        </p>
        <h2 className="mt-2 text-xl leading-snug font-semibold tracking-title">{props.title}</h2>
        {props.children}
      </article>
    </Page>
  );
}

/** "Open thread (O)": the item's thread, by button or key. */
function OpenThread(props: { threadId: string | undefined; label?: string }) {
  const navigate = useNavigate();
  const { threadId } = props;
  const open = () => threadId && void navigate({ to: "/t/$threadId", params: { threadId } });
  // O, not Enter: Enter belongs to whatever button has focus.
  useHotkey("o", open, { enabled: threadId !== undefined });
  if (!threadId) return null;
  return (
    <Button variant="primary" onClick={open}>
      {props.label ?? "Open thread"}
      <ButtonKey primary>O</ButtonKey>
    </Button>
  );
}

function OnForge(props: { pr: PrRef; label?: string }) {
  if (!props.pr.url) return null;
  return (
    <a
      href={props.pr.url}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "ghost" })}
    >
      {props.label ?? "Open on GitHub"}
    </a>
  );
}

const prLine = (pr: PrRef) => `#${pr.number} · ${pr.title}`;

function EventDetail(props: { event: FeedEvent }) {
  const { event } = props;
  const projectName = useProjectName();
  const context = `${projectName(event.project)} · ${event.context}`;
  const detail: FeedDetail | undefined = event.detail;
  switch (detail?.kind) {
    case "mention":
      return (
        <DetailFrame
          context={prLine(detail.pr)}
          at={event.at}
          title={`${detail.author} mentioned you`}
        >
          <div className="mt-4 rounded-card bg-secondary px-4 py-3 text-ui">
            <Suspense fallback={<p className="whitespace-pre-wrap">{detail.body}</p>}>
              <Markdown text={detail.body} />
            </Suspense>
          </div>
          {detail.reply && <MentionReply author={detail.author} target={detail.reply} />}
          <CardActions>
            <OnForge pr={detail.pr} />
            <OpenThread threadId={event.threadId} />
          </CardActions>
        </DetailFrame>
      );
    case "ci":
      return (
        <DetailFrame context={context} at={event.at} title={event.title}>
          <ul aria-label="Failing checks" className="mt-4 flex flex-col">
            {detail.checks.map((check) => (
              <li
                key={check.name}
                className="flex items-center gap-2.5 border-t py-2.5 last:border-b"
              >
                <Icon icon={XCircleIcon} size={16} className="text-status-failed" />
                <span className="min-w-0 flex-1 truncate text-ui">{check.name}</span>
                <span className="text-sm text-muted-foreground">{check.conclusion}</span>
                {check.url && (
                  <a
                    href={check.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${check.name} on GitHub`}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    Logs
                  </a>
                )}
              </li>
            ))}
          </ul>
          <CardActions>
            <OnForge pr={detail.pr} />
            <OpenThread threadId={event.threadId} />
          </CardActions>
        </DetailFrame>
      );
    case "pr":
      return (
        <DetailFrame context={context} at={event.at} title={event.title}>
          <p className="mt-3 flex items-center gap-2 text-ui text-muted-foreground">
            <Icon
              icon={detail.state === "merged" ? CheckCircleIcon : XCircleIcon}
              size={16}
              className={detail.state === "merged" ? "text-status-done" : "text-muted-foreground"}
            />
            {detail.state === "merged" ? "Merged" : "Closed without merging"} · {prLine(detail.pr)}
          </p>
          <CardActions>
            <OnForge pr={detail.pr} />
            <OpenThread threadId={event.threadId} />
          </CardActions>
        </DetailFrame>
      );
    default:
      return (
        <DetailFrame context={context} at={event.at} title={event.title}>
          <CardActions>
            <OpenThread threadId={event.threadId} />
          </CardActions>
        </DetailFrame>
      );
  }
}
