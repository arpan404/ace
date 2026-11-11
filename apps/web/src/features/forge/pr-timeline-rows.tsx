import type { ReactNode } from "react";
import type { ForgeComment } from "@ace/protocol";
import type { ForgeActivity, ForgeCommit } from "@ace/protocol/forge-browser";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkSimpleIcon,
  TagIcon,
  UsersIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { DiffStat } from "@/components/diff-stat.tsx";
import { PullRequestLink, pullRequestAt } from "@/components/pull-request-link.tsx";
import { PrTime } from "./pr-presentation.tsx";
import { PrThreadBox } from "./pr-thread-box.tsx";
import { PrCommentBox, TimelineIcon, TimelineStop, TimelineWords } from "./pr-timeline-box.tsx";
import {
  eventText,
  lifecycleWords,
  reviewVerdictWords,
  type PrConversationItem,
  type PrReference,
  type PrTimelinePush,
  type PrReviewVerdict,
} from "@ace/ui-core";
import { WebLink } from "@/components/web-link.tsx";

export type TimelineExpansion = { isOpen(id: string): boolean; toggle(id: string): void };

function CommentBox(props: { comment: ForgeComment; expansion: TimelineExpansion }) {
  const comment = props.comment;
  const id = `body:${comment.kind}:${comment.id}`;
  return (
    <PrCommentBox
      comment={comment}
      words={<span>commented</span>}
      place={comment.file ? `${comment.file}${comment.line ? `:${comment.line}` : ""}` : undefined}
      quoteTarget="conversation"
      open={props.expansion.isOpen(id)}
      onToggle={() => props.expansion.toggle(id)}
    />
  );
}
/** Where a reference points: a pull request opens in a tab beside this one, an issue on GitHub. */
function ReferenceTarget(props: { url: string; pullRequest: boolean; children: ReactNode }) {
  const className = "hover:underline focus-ring";
  const pr = props.pullRequest ? pullRequestAt(props.url) : undefined;
  if (pr)
    return (
      <PullRequestLink href={props.url} pr={pr} className={className}>
        {props.children}
      </PullRequestLink>
    );
  return (
    <WebLink href={props.url} className={className}>
      {props.children}
    </WebLink>
  );
}
function ReferenceLine(props: { reference: PrReference }) {
  const target = props.reference.target;
  if (!target) return <span>mentioned this pull request</span>;
  if (target.kind === "commit")
    return (
      <span>
        referenced this in <span className="font-mono text-2xs">{target.sha.slice(0, 7)}</span>
      </span>
    );
  const label = (
    <>
      <span className="text-subtle-foreground">#{target.number}</span>{" "}
      <span className="text-foreground">{target.title}</span>
    </>
  );
  return (
    <span className="min-w-0">
      referenced this in{" "}
      {target.url ? (
        <ReferenceTarget url={target.url} pullRequest={target.pullRequest}>
          {label}
        </ReferenceTarget>
      ) : (
        label
      )}
    </span>
  );
}
/** A stop that folds several things into one line until it is opened. */
function FoldButton(props: {
  id: string;
  label: string;
  at: string | null;
  expansion: TimelineExpansion;
}) {
  const open = props.expansion.isOpen(props.id);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => props.expansion.toggle(props.id)}
      className="flex items-center gap-1.5 text-ui text-muted-foreground hover:text-foreground focus-ring"
    >
      <CaretRightIcon
        aria-hidden
        size={12}
        className={cn("transition-transform", open && "rotate-90")}
      />
      <span>{props.label}</span>
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <PrTime at={props.at} />
    </button>
  );
}
function eventIcon(event: string): Icon {
  if (event.includes("label")) return TagIcon;
  if (event.includes("review_request")) return UsersIcon;
  if (event.includes("force_push")) return ArrowsClockwiseIcon;
  if (event === "committed") return GitCommitIcon;
  if (event === "commented" || event === "reviewed") return ChatCircleIcon;
  return GitPullRequestIcon;
}
/** A label event names its label as a small pill: "added (bug)". */
function EventWords(props: { event: ForgeActivity }) {
  const { event } = props;
  if ((event.event === "labeled" || event.event === "unlabeled") && event.subject)
    return (
      <>
        <span>{event.event === "labeled" ? "added" : "removed"}</span>
        <span className="rounded-full border border-border px-2 text-xs font-medium text-muted-foreground">
          {event.subject}
        </span>
      </>
    );
  return <span>{eventText(event)}</span>;
}
function CommitLine(props: { commit: ForgeCommit; onOpen?: ((sha: string) => void) | undefined }) {
  const { commit, onOpen } = props;
  const headline = commit.message.split("\n")[0];
  return (
    <li className="flex min-w-0 items-baseline gap-3 py-0.5">
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(commit.sha)}
          className="min-w-0 truncate text-left text-ui text-foreground hover:underline focus-ring"
        >
          {headline}
        </button>
      ) : (
        <span className="min-w-0 truncate text-ui text-foreground">{headline}</span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-3">
        {commit.additions !== undefined && commit.deletions !== undefined && (
          <DiffStat additions={commit.additions} deletions={commit.deletions} />
        )}
        <WebLink
          href={commit.url}
          className="font-mono text-xs text-subtle-foreground hover:underline focus-ring"
        >
          {commit.sha.slice(0, 7)}
        </WebLink>
      </span>
    </li>
  );
}
function PushStop(props: {
  push: PrTimelinePush;
  onOpenCommit?: ((sha: string) => void) | undefined;
}) {
  const { push } = props;
  const count = push.commits.length;
  return (
    <TimelineStop marker={<TimelineIcon icon={GitCommitIcon} />}>
      <TimelineWords actor={push.author} at={push.at}>
        <span>{count === 1 ? "pushed 1 commit" : `pushed ${count} commits`}</span>
      </TimelineWords>
      <ul aria-label="Commits" className="mt-1.5 list-none p-0">
        {push.commits.map((commit) => (
          <CommitLine key={commit.sha} commit={commit} onOpen={props.onOpenCommit} />
        ))}
      </ul>
    </TimelineStop>
  );
}
/** A verdict's icon: approved and requested changes settle something, so they are solid. */
const verdictIcon: Record<PrReviewVerdict, { icon: Icon; solid: boolean }> = {
  approved: { icon: CheckIcon, solid: true },
  changes: { icon: XIcon, solid: true },
  commented: { icon: ChatCircleIcon, solid: false },
  dismissed: { icon: ChatCircleIcon, solid: false },
  pending: { icon: ChatCircleIcon, solid: false },
};

export function PrTimelineRow(props: {
  item: PrConversationItem;
  expansion: TimelineExpansion;
  onOpenCommit?: ((sha: string) => void) | undefined;
}) {
  const { item, expansion } = props;
  switch (item.kind) {
    case "push":
      return <PushStop push={item} onOpenCommit={props.onOpenCommit} />;
    case "review": {
      const words = reviewVerdictWords[item.verdict];
      const verdict = (
        <>
          <span
            data-tone={words.tone}
            className={cn("font-medium", words.tone && "text-(--tone-text)")}
          >
            {words.text}
          </span>
          {item.stale && <span className="text-subtle-foreground">outdated</span>}
        </>
      );
      // A verdict with nothing written is one line on the rail; one with words is a box.
      if (!item.comment.body.trim()) {
        const mark = verdictIcon[item.verdict];
        return (
          <TimelineStop
            className={item.stale ? "opacity-55" : undefined}
            marker={<TimelineIcon icon={mark.icon} tone={words.tone} solid={mark.solid} />}
          >
            <TimelineWords actor={item.comment.author} at={item.at}>
              {verdict}
            </TimelineWords>
          </TimelineStop>
        );
      }
      return (
        <PrCommentBox
          className={item.stale ? "opacity-55" : undefined}
          comment={item.comment}
          words={verdict}
          quoteTarget="conversation"
          open={expansion.isOpen(`body:${item.id}`)}
          onToggle={() => expansion.toggle(`body:${item.id}`)}
        />
      );
    }
    case "comment":
      return <CommentBox comment={item.comment} expansion={expansion} />;
    case "thread":
      return <PrThreadBox thread={item.thread} />;
    case "comments": {
      const open = expansion.isOpen(item.id);
      const authors = item.authors.length;
      return (
        <>
          <TimelineStop
            marker={<TimelineIcon icon={ChatCircleIcon} />}
            className={open ? undefined : "opacity-70"}
          >
            <FoldButton
              id={item.id}
              label={`${item.comments.length} comments · ${authors} ${authors === 1 ? "author" : "authors"}`}
              at={item.at}
              expansion={expansion}
            />
          </TimelineStop>
          {open &&
            item.comments.map((comment) => (
              <CommentBox
                key={`${comment.kind}:${comment.id}`}
                comment={comment}
                expansion={expansion}
              />
            ))}
        </>
      );
    }
    case "references": {
      const only = item.references.length === 1 ? item.references[0] : undefined;
      const open = expansion.isOpen(item.id);
      return (
        <TimelineStop marker={<TimelineIcon icon={LinkSimpleIcon} />}>
          {only ? (
            <TimelineWords actor={only.actor} at={only.at}>
              <ReferenceLine reference={only} />
            </TimelineWords>
          ) : (
            <>
              <FoldButton
                id={item.id}
                label={`${item.references.length} references`}
                at={item.at}
                expansion={expansion}
              />
              {open && (
                <div className="mt-2 space-y-1.5">
                  {item.references.map((reference) => (
                    <TimelineWords key={reference.id} actor={reference.actor} at={reference.at}>
                      <ReferenceLine reference={reference} />
                    </TimelineWords>
                  ))}
                </div>
              )}
            </>
          )}
        </TimelineStop>
      );
    }
    case "lifecycle": {
      const words = lifecycleWords[item.state];
      const ended = item.state === "merged" || item.state === "closed";
      return (
        <TimelineStop
          marker={
            <TimelineIcon
              icon={item.state === "merged" ? GitMergeIcon : GitPullRequestIcon}
              tone={words.tone}
              solid={ended}
            />
          }
        >
          <TimelineWords actor={item.event.actor} at={item.at}>
            <span>{words.text}</span>
          </TimelineWords>
        </TimelineStop>
      );
    }
    case "event":
      return (
        <TimelineStop marker={<TimelineIcon icon={eventIcon(item.event.event)} />}>
          <TimelineWords actor={item.event.actor} at={item.at}>
            <EventWords event={item.event} />
          </TimelineWords>
        </TimelineStop>
      );
  }
}
