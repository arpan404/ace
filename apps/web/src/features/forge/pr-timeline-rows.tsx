import type { ComponentType, ReactNode } from "react";
import { PrClampedText } from "./pr-clamped.tsx";
import type { ForgeComment } from "@ace/protocol";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChatCircleIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkSimpleIcon,
  TagIcon,
  UsersIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { DiffStat } from "@/components/diff-stat.tsx";
import { PullRequestLink, pullRequestAt } from "@/components/pull-request-link.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { PrOwnComment } from "./pr-review-forms.tsx";
import { PrReactions } from "./pr-reactions.tsx";
import {
  eventText,
  type PrLifecycleState,
  type PrReference,
  type PrReviewVerdict,
  type PrTimelineItem,
} from "./pr-timeline.ts";
import { WebLink } from "@/components/web-link.tsx";

export type TimelineExpansion = { isOpen(id: string): boolean; toggle(id: string): void };

const verdictWords: Record<PrReviewVerdict, { text: string; tone?: string }> = {
  approved: { text: "approved", tone: "done" },
  changes: { text: "requested changes", tone: "failed" },
  commented: { text: "reviewed" },
  dismissed: { text: "review dismissed" },
  pending: { text: "review pending" },
};
const lifecycleWords: Record<PrLifecycleState, { text: string; tone: string }> = {
  opened: { text: "opened this pull request", tone: "done" },
  reopened: { text: "reopened this pull request", tone: "done" },
  merged: { text: "merged this pull request", tone: "waiting" },
  closed: { text: "closed this pull request", tone: "failed" },
};

function Avatar(props: { name: string; url?: string | undefined; small?: boolean }) {
  return (
    <PrAvatar name={props.name} url={props.url} className={props.small ? undefined : "size-8"} />
  );
}
function IconMarker(props: { icon: ComponentType<IconProps>; tone?: string | undefined }) {
  const Icon = props.icon;
  return (
    <span
      data-tone={props.tone}
      className={cn(
        "flex size-8 items-center justify-center rounded-full border border-border bg-panel",
        props.tone ? "text-(--tone-text)" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden size={16} />
    </span>
  );
}
/** One stop on the rail: a 32px marker, then the content indented beside it. */
function Row(props: { marker: ReactNode; children: ReactNode; className?: string | undefined }) {
  return (
    <div className={cn("relative flex gap-4 pb-5", props.className)}>
      <div className="relative z-[1] flex size-8 shrink-0 items-center justify-center bg-panel">
        {props.marker}
      </div>
      <div className="min-w-0 flex-1 pt-1.5">{props.children}</div>
    </div>
  );
}
function Line(props: { children: ReactNode; at: string | null }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-ui text-muted-foreground">
      {props.children}
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <PrTime at={props.at} />
    </p>
  );
}
/** A long body shows about six lines until it is opened. */
function Clamped(props: { id: string; text: string; expansion: TimelineExpansion }) {
  if (!props.text.trim()) return null;
  return (
    <div className="mt-1.5">
      <PrClampedText
        text={props.text}
        open={props.expansion.isOpen(props.id)}
        onToggle={() => props.expansion.toggle(props.id)}
      />
    </div>
  );
}
function CommentBody(props: { comment: ForgeComment; expansion: TimelineExpansion }) {
  const comment = props.comment;
  return (
    <>
      <Line at={comment.createdAt ?? comment.updatedAt}>
        <span className="font-medium text-foreground">{comment.author}</span>
        <span>commented</span>
        {comment.file && (
          <span className="truncate font-mono text-2xs text-subtle-foreground">
            {comment.file}
            {comment.line ? `:${comment.line}` : ""}
          </span>
        )}
      </Line>
      <Clamped
        id={`body:${comment.kind}:${comment.id}`}
        text={comment.body}
        expansion={props.expansion}
      />
      {comment.kind !== "review" && (
        <PrReactions subject={{ kind: comment.kind, commentId: comment.id }} />
      )}
      <PrOwnComment comment={comment} />
    </>
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
/** A row that folds several things into one line until it is opened. */
function Folded(props: {
  id: string;
  label: string;
  at: string | null;
  expansion: TimelineExpansion;
  children: ReactNode;
}) {
  const open = props.expansion.isOpen(props.id);
  return (
    <>
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
      {open && <div className="mt-2 space-y-3">{props.children}</div>}
    </>
  );
}
function eventIcon(event: string): ComponentType<IconProps> {
  if (event.includes("label")) return TagIcon;
  if (event.includes("review_request")) return UsersIcon;
  if (event.includes("force_push")) return ArrowsClockwiseIcon;
  if (event === "committed") return GitCommitIcon;
  if (event === "commented" || event === "reviewed") return ChatCircleIcon;
  return GitPullRequestIcon;
}

export function PrTimelineRow(props: {
  item: PrTimelineItem;
  expansion: TimelineExpansion;
  onOpenCommit?: ((sha: string) => void) | undefined;
}) {
  const { item, expansion } = props;
  switch (item.kind) {
    case "commit": {
      const commit = item.commit;
      const headline = commit.message.split("\n")[0];
      const onOpen = props.onOpenCommit;
      return (
        <Row marker={<Avatar name={commit.author} url={commit.authorAvatarUrl} />}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(commit.sha)}
                  className="block max-w-full truncate text-left text-xs font-semibold hover:underline focus-ring"
                >
                  {headline}
                </button>
              ) : (
                <p className="truncate text-xs font-semibold">{headline}</p>
              )}
              <p className="flex items-baseline gap-2 text-subtle-foreground">
                <WebLink
                  href={commit.url}
                  className="font-mono text-2xs hover:underline focus-ring"
                >
                  {commit.sha.slice(0, 7)}
                </WebLink>
                <PrTime at={item.at} />
              </p>
            </div>
            {commit.additions !== undefined && commit.deletions !== undefined && (
              <DiffStat
                className="shrink-0 pt-0.5"
                additions={commit.additions}
                deletions={commit.deletions}
              />
            )}
          </div>
        </Row>
      );
    }
    case "review": {
      const words = verdictWords[item.verdict];
      return (
        <Row
          marker={<Avatar name={item.comment.author} url={item.comment.authorAvatarUrl} />}
          className={item.stale ? "opacity-55" : undefined}
        >
          <Line at={item.at}>
            <span className="font-medium text-foreground">{item.comment.author}</span>
            <span
              data-tone={words.tone}
              className={cn("font-medium", words.tone && "text-(--tone-text)")}
            >
              {words.text}
            </span>
            {item.stale && <span className="text-subtle-foreground">outdated</span>}
          </Line>
          <Clamped id={`body:${item.id}`} text={item.comment.body} expansion={expansion} />
        </Row>
      );
    }
    case "comment":
      return (
        <Row marker={<Avatar name={item.comment.author} url={item.comment.authorAvatarUrl} />}>
          <CommentBody comment={item.comment} expansion={expansion} />
        </Row>
      );
    case "comments": {
      const open = expansion.isOpen(item.id);
      const first = item.comments[0];
      const authors = item.authors.length;
      return (
        <Row
          marker={
            <span className={cn(!open && "grayscale")}>
              <Avatar name={first?.author ?? ""} url={first?.authorAvatarUrl} />
            </span>
          }
          className={open ? undefined : "opacity-55"}
        >
          <Folded
            id={item.id}
            label={`${item.comments.length} comments · ${authors} ${authors === 1 ? "author" : "authors"}`}
            at={item.at}
            expansion={expansion}
          >
            {item.comments.map((comment) => (
              <div key={`${comment.kind}:${comment.id}`} className="flex gap-2">
                <Avatar small name={comment.author} url={comment.authorAvatarUrl} />
                <div className="min-w-0 flex-1">
                  <CommentBody comment={comment} expansion={expansion} />
                </div>
              </div>
            ))}
          </Folded>
        </Row>
      );
    }
    case "references": {
      const only = item.references.length === 1 ? item.references[0] : undefined;
      return (
        <Row marker={<IconMarker icon={LinkSimpleIcon} />}>
          {only ? (
            <Line at={only.at}>
              <span className="font-medium text-foreground">{only.actor}</span>
              <ReferenceLine reference={only} />
            </Line>
          ) : (
            <Folded
              id={item.id}
              label={`${item.references.length} references`}
              at={item.at}
              expansion={expansion}
            >
              {item.references.map((reference) => (
                <Line key={reference.id} at={reference.at}>
                  <span className="font-medium text-foreground">{reference.actor}</span>
                  <ReferenceLine reference={reference} />
                </Line>
              ))}
            </Folded>
          )}
        </Row>
      );
    }
    case "lifecycle": {
      const words = lifecycleWords[item.state];
      return (
        <Row
          marker={
            <IconMarker
              icon={item.state === "merged" ? GitMergeIcon : GitPullRequestIcon}
              tone={words.tone}
            />
          }
        >
          <Line at={item.at}>
            <span className="font-medium text-foreground">{item.event.actor}</span>
            <span data-tone={words.tone} className="text-(--tone-text)">
              {words.text}
            </span>
          </Line>
        </Row>
      );
    }
    case "event":
      return (
        <Row marker={<IconMarker icon={eventIcon(item.event.event)} />}>
          <Line at={item.at}>
            <span className="font-medium text-foreground">{item.event.actor}</span>
            <span>{eventText(item.event)}</span>
          </Line>
        </Row>
      );
  }
}
