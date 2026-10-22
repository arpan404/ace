import { type ReviewOutcome, reviewOutcomeLabels } from "@ace/ui-core";
import { useState, type ReactNode } from "react";
import { ArrowsDownUpIcon, FunnelIcon } from "@phosphor-icons/react";
import type { ForgeComment, ForgePrStatus } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { cardEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { PrOwnComment, PrThreadControls } from "./pr-review-forms.tsx";
import { PrSection } from "./pr-section.tsx";
import { PrClampedText } from "./pr-clamped.tsx";
import { PrReactions } from "./pr-reactions.tsx";
import { PrSuggestionActions } from "./pr-suggestions.tsx";
import { conversation } from "./pr-summary-model.ts";

const page = 10;
const verdicts: Record<string, ReviewOutcome> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  DISMISSED: "dismissed",
};
const verdictTone: Record<ReviewOutcome, string> = {
  approved: "text-status-done",
  changes: "text-status-failed",
  commented: "text-muted-foreground",
  dismissed: "text-subtle-foreground",
};

function CardHeader(props: { comment: ForgeComment; children?: ReactNode }) {
  const verdict = verdicts[props.comment.reviewState?.toUpperCase() ?? ""];
  return (
    <div className="flex min-w-0 items-center gap-1.5 bg-foreground/3 px-2.5 py-1.5 text-xs">
      <PrAvatar name={props.comment.author} url={props.comment.authorAvatarUrl} />
      <span className="truncate font-medium">{props.comment.author}</span>
      <PrTime at={props.comment.createdAt ?? props.comment.updatedAt} />
      {verdict && (
        <span className={cn("font-medium", verdictTone[verdict])}>
          {reviewOutcomeLabels[verdict]}
        </span>
      )}
      {props.children}
    </div>
  );
}

function CommentCard(props: { comment: ForgeComment; open: boolean; onToggle(): void }) {
  const { comment } = props;
  return (
    <li className={cn("overflow-hidden rounded-md", cardEdge)}>
      <CardHeader comment={comment}>
        {comment.kind === "inline" && comment.file && (
          <span className="ml-auto truncate font-mono text-subtle-foreground">
            {`${comment.file}:${comment.line ?? ""}`}
          </span>
        )}
      </CardHeader>
      {comment.body.trim() && (
        <div className="space-y-2 px-2.5 py-2">
          <PrClampedText text={comment.body} open={props.open} onToggle={props.onToggle} />
          <PrSuggestionActions comment={comment} outdated={comment.line === null} />
          {comment.kind !== "review" && (
            <PrReactions subject={{ kind: comment.kind, commentId: comment.id }} />
          )}
          <PrOwnComment comment={comment} />
        </div>
      )}
    </li>
  );
}

function ThreadCard(props: {
  thread: ForgePrStatus["reviewThreads"][number];
  prKey: string;
  isOpen(key: string): boolean;
  onToggle(key: string): void;
}) {
  const { thread } = props;
  const [open, setOpen] = useState(!thread.resolved);
  const first = thread.comments[0];
  return (
    <li className={cn("overflow-hidden rounded-md", cardEdge)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 bg-foreground/3 px-2.5 py-1.5 text-left text-xs focus-ring-inset"
      >
        {first && <PrAvatar name={first.author} url={first.authorAvatarUrl} />}
        <span className="truncate font-mono text-muted-foreground">
          {`${thread.file}:${thread.line ?? ""}`}
        </span>
        {thread.outdated && <span className="text-subtle-foreground">Outdated</span>}
        <span
          className={cn(
            "ml-auto shrink-0 rounded-xs px-1.5 font-medium",
            thread.resolved ? "text-status-done" : "text-muted-foreground",
          )}
        >
          {thread.resolved ? "Resolved" : `${thread.comments.length} comments`}
        </span>
      </button>
      {!open && first && (
        <p className="truncate px-2.5 py-1.5 text-xs text-muted-foreground">{first.body}</p>
      )}
      {open && (
        <div className="space-y-2 px-2.5 py-2">
          {thread.comments.map((comment) => (
            <div key={comment.id} className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs">
                <span className="font-medium">{comment.author}</span>
                <PrTime at={comment.createdAt ?? comment.updatedAt} />
              </p>
              <PrClampedText
                text={comment.body}
                open={props.isOpen(`${thread.id}:${comment.id}`)}
                onToggle={() => props.onToggle(`${thread.id}:${comment.id}`)}
              />
              <PrSuggestionActions comment={comment} outdated={thread.outdated} />
              <PrReactions subject={{ kind: "inline", commentId: comment.id }} />
              <PrOwnComment comment={comment} />
            </div>
          ))}
          <PrThreadControls
            id={thread.id}
            resolved={thread.resolved}
            replyTo={first?.id}
            prKey={props.prKey}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The PR's conversation as cards, newest first by default, ten at a time. Bot comments and
 * resolved threads can be filtered out; resolved threads start folded to one line.
 */
export function PrComments(props: { status: ForgePrStatus }) {
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [bots, setBots] = useState(true);
  const [resolved, setResolved] = useState(true);
  const [limit, setLimit] = useState(page);
  // Which long comments are open, kept here so cards can remount without folding again.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const view = conversation(props.status, { bots, resolved, order, limit });
  const prKey = JSON.stringify(props.status.ref);
  const older = view.older > 0 && (
    <Button size="sm" onClick={() => setLimit(limit + page)}>
      {`Show ${Math.min(page, view.older)} older (${view.older} hidden)`}
    </Button>
  );
  // No conversation yet: nothing to show; the comment button is always there.
  if (view.total === 0) return null;
  return (
    <PrSection
      title="Comments"
      count={view.total}
      action={
        view.total > 0 && (
          <>
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="xs" />}>
                <FunnelIcon aria-hidden size={14} />
                {view.filtered ? `${view.filtered} hidden` : "Filter"}
              </MenuTrigger>
              <MenuContent align="end">
                <MenuCheckboxItem checked={bots} onCheckedChange={setBots}>
                  Bot comments
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={resolved} onCheckedChange={setResolved}>
                  Resolved and dismissed
                </MenuCheckboxItem>
              </MenuContent>
            </Menu>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
            >
              <ArrowsDownUpIcon aria-hidden size={14} />
              {order === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          </>
        )
      }
    >
      {view.items.length ? (
        <div className="space-y-2">
          {order === "oldest" && older}
          <ol className="space-y-2">
            {view.items.map((item) =>
              item.kind === "comment" ? (
                <CommentCard
                  key={item.key}
                  comment={item.comment}
                  open={expanded.has(item.key)}
                  onToggle={() => toggle(item.key)}
                />
              ) : (
                <ThreadCard
                  key={item.key}
                  thread={item.thread}
                  prKey={prKey}
                  isOpen={(key) => expanded.has(key)}
                  onToggle={toggle}
                />
              ),
            )}
          </ol>
          {order === "newest" && older}
          {limit > page && (
            <Button variant="ghost" size="sm" onClick={() => setLimit(page)}>
              {`Show only ${page} recent`}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-ui text-muted-foreground">
          {view.total ? "Every comment is filtered out." : "No comments yet."}
        </p>
      )}
    </PrSection>
  );
}
