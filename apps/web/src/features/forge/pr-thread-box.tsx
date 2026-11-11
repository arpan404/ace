import type { ForgePrStatus } from "@ace/protocol";
import { hiddenReasonOf, plural, threadPlace } from "@ace/ui-core";
import { attentionItems } from "./pr-summary-model.ts";
import { cn } from "@/lib/cn.ts";
import { PrBoxHead, prBoxFoot } from "./pr-box.tsx";
import { PrComment } from "./pr-comment.tsx";
import { PrThreadHunk } from "./pr-earlier-code.tsx";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { PrTime } from "./pr-presentation.tsx";
import { usePrDetail, usePrIdentity, usePrReview } from "./pr-review-context.tsx";
import { TextAction } from "./pr-text-action.tsx";
import { PrReplyField, PrResolveButton, useThreadView } from "./pr-thread.tsx";
import { TimelineBox } from "./pr-timeline-box.tsx";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** The footer's resolve, drawn as a button beside the reply field. */
const resolveButton =
  "inline-flex h-7 items-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:bg-surface-1";

/** The closed reply field at a conversation's foot, looking like the field it opens. */
function ReplyPrompt(props: { onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border bg-background px-2.5 text-left text-xs text-subtle-foreground hover:border-border-strong focus-ring"
    >
      Reply…
    </button>
  );
}

/**
 * "Fix with agent" for a conversation nobody resolved, asked as the Summary's Blocking the
 * merge row asks it. Offered only once GitHub says its first comment is shown.
 */
function ThreadFix(props: { thread: ReviewThread }) {
  const review = usePrReview();
  const detail = usePrDetail();
  const identity = usePrIdentity();
  const agent = useFixWithAgent({ workspaceId: identity?.workspaceId ?? "", detail });
  const state = review?.state;
  const open = detail?.status.state === "open" || detail?.status.state === "draft";
  if (!detail || !open || !Array.isArray(state?.hidden)) return null;
  const [item] = attentionItems(
    { checks: [], reviewThreads: [props.thread] },
    (c) => hiddenReasonOf(state, c) !== undefined,
  );
  if (!item) return null;
  return (
    <TextAction strong disabled={!review?.ready} onClick={() => agent.fix(item)}>
      Fix with agent
    </TextAction>
  );
}

/**
 * A conversation on the code, in the Timeline: a box with its first author and when, the
 * hunk it was written on, its comments, and a foot with the reply field, Resolve and Fix with
 * agent. A resolved one starts folded to its head and a one-line preview.
 */
export function PrThreadBox(props: { thread: ReviewThread; className?: string | undefined }) {
  const { thread } = props;
  const view = useThreadView(thread);
  const { open, first, preview } = view;
  return (
    <TimelineBox
      author={first?.author ?? ""}
      avatarUrl={first?.authorAvatarUrl}
      className={props.className}
    >
      <section
        aria-label={`Conversation on ${threadPlace(thread)}`}
        className="min-w-0 font-sans whitespace-normal"
      >
        <PrBoxHead
          className={cn(!open && "rounded-b-lg border-b-0")}
          actions={
            <TextAction aria-expanded={open} onClick={() => view.setOpen(!open)} className="px-1.5">
              {open ? "Hide" : "Show"}
            </TextAction>
          }
        >
          <span className="truncate font-semibold text-foreground">{first?.author}</span>
          <span>commented on the code</span>
          {first && (
            <>
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <PrTime at={first.createdAt ?? first.updatedAt} />
            </>
          )}
          {thread.outdated && (
            <span className="shrink-0 text-xs text-subtle-foreground">Outdated</span>
          )}
          {thread.resolved && (
            <span className="shrink-0 text-xs text-subtle-foreground">Resolved</span>
          )}
          {view.fixing && (
            <span className="shrink-0 text-xs text-status-working">Agent fixing this</span>
          )}
        </PrBoxHead>
        {!open ? (
          preview &&
          first && (
            <button
              type="button"
              onClick={() => view.setOpen(true)}
              className="flex w-full min-w-0 items-center gap-2 rounded-b-lg border-t border-border px-4 py-2.5 text-left text-ui text-muted-foreground hover:text-foreground focus-ring"
            >
              <span className="min-w-0 flex-1 truncate">
                <bdi className="font-mono text-xs">{threadPlace(thread)}</bdi>{" "}
                <span className="font-medium text-foreground">{first.author}</span>{" "}
                <span className={cn(preview.hidden && "text-subtle-foreground")}>
                  {preview.text}
                </span>
              </span>
              {thread.comments.length > 1 && (
                <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                  {plural(thread.comments.length, "comment")}
                </span>
              )}
            </button>
          )
        ) : (
          <>
            <PrThreadHunk thread={thread} className="mx-4 mt-3" />
            <ol className="list-none space-y-3 px-4 pt-3 pb-3.5">
              {thread.comments.map((comment) => (
                <li key={comment.id}>
                  <PrComment
                    comment={comment}
                    quoteTarget={`thread:${thread.id}`}
                    outdated={thread.outdated}
                    open={view.expanded.has(comment.id)}
                    onToggle={() => view.toggle(comment.id)}
                  />
                </li>
              ))}
            </ol>
            {first && (
              <div className={cn(prBoxFoot, "flex-wrap bg-background")}>
                <PrReplyField
                  threadId={thread.id}
                  rootCommentId={first.id}
                  className="min-w-0 basis-full"
                  closed={ReplyPrompt}
                />
                <PrResolveButton thread={thread} className={resolveButton} />
                {!thread.resolved && <ThreadFix thread={thread} />}
              </div>
            )}
          </>
        )}
      </section>
    </TimelineBox>
  );
}
