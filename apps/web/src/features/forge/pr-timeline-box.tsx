import type { ComponentType, ReactNode } from "react";
import type { ForgeComment } from "@ace/protocol";
import type { IconProps } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { PrBoxHead, prBox } from "./pr-box.tsx";
import { CommentContent, CommentHeadControls, useCommentControls } from "./pr-comment.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { QuoteTarget } from "./pr-quote.tsx";

/*
 * The Timeline's conversation: a 40px gutter with a thin line through it, small events as
 * one-line stops on the line, comments and reviews as boxes pointing back at their author.
 */

/** The gutter's line, drawn behind the stops through their icons' centres. */
export const timelineLine =
  "relative before:absolute before:top-5 before:bottom-5 before:left-[19px] before:w-0.5 before:bg-border-soft";

/** One stop on the line: its mark in the gutter, then what happened. */
export function TimelineStop(props: {
  marker: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn("grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 pb-4.5", props.className)}>
      <div className="relative z-[1] flex justify-center">{props.marker}</div>
      <div className="min-w-0 pt-1">{props.children}</div>
    </div>
  );
}

/**
 * An event's small round icon. A verdict that settles something (approved, a failure) is a
 * solid disc in its tone; the rest sit quietly on the page with a hairline edge.
 */
export function TimelineIcon(props: {
  icon: ComponentType<IconProps>;
  tone?: string | undefined;
  solid?: boolean | undefined;
}) {
  const Icon = props.icon;
  return (
    <span
      data-tone={props.tone}
      className={cn(
        "grid size-7 place-items-center rounded-full border",
        props.solid
          ? "border-(--tone) bg-(--tone) text-background"
          : cn(
              "border-border bg-panel",
              props.tone ? "text-(--tone-text)" : "text-muted-foreground",
            ),
      )}
    >
      <Icon aria-hidden size={14} weight={props.solid ? "bold" : "regular"} />
    </span>
  );
}

/** An event's words: the actor in bold, what they did, and when. */
export function TimelineWords(props: { actor: string; children: ReactNode; at: string | null }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-ui text-muted-foreground">
      <span className="font-semibold text-foreground">{props.actor}</span>
      {props.children}
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <PrTime at={props.at} />
    </p>
  );
}

/** A box in the conversation: its author's 40px avatar in the gutter, a caret pointing at it. */
export function TimelineBox(props: {
  author: string;
  avatarUrl?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
  boxClassName?: string | undefined;
}) {
  return (
    <div className={cn("grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 pb-4.5", props.className)}>
      <div className="relative z-[1]">
        <PrAvatar name={props.author} url={props.avatarUrl} className="size-10" />
      </div>
      <div
        className={cn(
          prBox,
          "relative min-w-0 before:absolute before:top-3.5 before:-left-[7px] before:size-3 before:rotate-45 before:border-b before:border-l before:border-border before:bg-surface-1",
          props.boxClassName,
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

/**
 * A comment or review drawn as a box: a head bar with the author, what they did and when,
 * its reaction picker and ⋯ menu at the right, then its text. Hidden, editing and reactions
 * behave as anywhere else a comment shows.
 */
export function PrCommentBox(props: {
  comment: ForgeComment;
  /** What the author did: "commented", a review verdict. */
  words: ReactNode;
  /** Trailing heading detail, such as the file and line a comment is on. */
  place?: ReactNode;
  quoteTarget?: QuoteTarget | undefined;
  open: boolean;
  onToggle(): void;
  className?: string | undefined;
}) {
  const { comment } = props;
  const controls = useCommentControls(comment, props.quoteTarget);
  return (
    <TimelineBox
      author={comment.author}
      avatarUrl={comment.authorAvatarUrl}
      className={props.className}
    >
      <div className="group/comment min-w-0" data-comment-id={`${comment.kind}:${comment.id}`}>
        <PrBoxHead actions={<CommentHeadControls controls={controls} />}>
          <span className="truncate font-semibold text-foreground">{comment.author}</span>
          {props.words}
          <span aria-hidden className="text-subtle-foreground">
            ·
          </span>
          <PrTime at={comment.createdAt ?? comment.updatedAt} />
          {props.place && (
            <span className="min-w-0 truncate font-mono text-xs text-subtle-foreground">
              {props.place}
            </span>
          )}
        </PrBoxHead>
        <div className="px-4 pt-3 pb-3.5 empty:hidden">
          <CommentContent controls={controls} open={props.open} onToggle={props.onToggle} />
        </div>
      </div>
    </TimelineBox>
  );
}
