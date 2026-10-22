import { useRef, useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { ForgePrStatus } from "@ace/protocol";
import { useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrComment } from "./pr-comment.tsx";
import { plural, previewOf, threadPlace } from "./pr-comment-model.ts";
import { appendTo, useQuotedInto } from "./pr-quote.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { useFocusAsk, useFold, useReplyOpen } from "./pr-ui-store.tsx";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** Where a reply's unsent text is kept on this device, one per thread and place. */
export const replyDraftKey = (
  workspaceId: string,
  prKey: string,
  threadId: string,
  place: ReplyPlace = "thread",
) => `pr:${workspaceId}:${prKey}:reply:${threadId}${place === "thread" ? "" : `:${place}`}`;

/**
 * Where a reply is written: under its conversation, or on the conversation's Needs attention
 * row. Each keeps its own text, and quote replies go only to the conversation's own.
 */
export type ReplyPlace = "thread" | "attention";

/** The open-state key of a reply field. */
export const replyField = (threadId: string, place: ReplyPlace = "thread") =>
  place === "thread" ? threadId : `${place}:${threadId}`;

/**
 * A reply to a review thread: under its conversation, one quiet "Reply…" line until chosen;
 * elsewhere, opened by its own Reply button. Then the Markdown editor with Cancel and Reply.
 * Its text survives reloads, and its open state survives the row scrolling away; only the
 * person's own action focuses it.
 */
export function PrReplyField(props: {
  threadId: string;
  /** GitHub takes replies on the thread's first comment. */
  rootCommentId: number;
  place?: ReplyPlace;
  className?: string | undefined;
}) {
  const review = usePrReview();
  const place = props.place ?? "thread";
  const prKey = JSON.stringify(review?.detail.status.ref ?? null);
  const draft = useMarkdownDraft(
    review ? replyDraftKey(review.workspaceId, prKey, props.threadId, place) : undefined,
  );
  const field = replyField(props.threadId, place);
  const [asked, setAsked] = useReplyOpen(field);
  const open = !!asked || draft.text.trim() !== "";
  const box = useRef<HTMLDivElement>(null);
  const askFocus = useFocusAsk(`reply:${field}`, box);
  useQuotedInto(
    `thread:${props.threadId}`,
    (text) => {
      draft.setText(appendTo(draft.text, text));
      setAsked(true);
      askFocus();
    },
    place === "thread",
  );
  const canComment = !!review?.state?.canComment;
  const disabled = !review?.ready || review.pending || !canComment;
  if (!review?.state || !canComment) return null;
  const close = () => setAsked(undefined);
  const send = () => {
    const body = draft.text;
    if (disabled || !body.trim()) return;
    void review.run({ kind: "reply", commentId: props.rootCommentId, body }).then((ok) => {
      if (ok && draft.clear(body)) close();
    });
  };
  if (!open)
    return place === "thread" ? (
      <button
        type="button"
        onClick={() => {
          setAsked(true);
          askFocus();
        }}
        className={cn(
          "flex h-8 w-full items-center rounded-md px-3 text-left text-ui text-subtle-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] hover:text-muted-foreground focus-ring",
          props.className,
        )}
      >
        Reply…
      </button>
    ) : null;
  return (
    <div ref={box} className={cn("space-y-2", props.className)}>
      <MarkdownEditor
        label="Reply"
        placeholder="Reply"
        maxLength={60_000}
        value={draft.text}
        onChange={draft.setText}
        onSubmit={send}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            draft.clear();
            close();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" disabled={disabled || !draft.text.trim()} onClick={send}>
          Reply
        </Button>
      </div>
    </div>
  );
}

/** Resolve or unresolve a review thread, where GitHub lets the viewer. */
export function PrResolveButton(props: { thread: ReviewThread }) {
  const review = usePrReview();
  if (!review?.state?.resolvableThreads.includes(props.thread.id)) return null;
  const { thread } = props;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!review.ready || review.pending}
      onClick={() =>
        void review.run({
          kind: thread.resolved ? "thread.unresolve" : "thread.resolve",
          threadId: thread.id,
        })
      }
    >
      {thread.resolved ? "Unresolve conversation" : "Resolve conversation"}
    </Button>
  );
}

/**
 * One review conversation: its comments in order, a reply field, and Resolve. A resolved one
 * starts folded to a single line. `place` names the file and line, for lists away from the diff.
 */
export function PrThread(props: {
  thread: ReviewThread;
  place?: boolean;
  className?: string | undefined;
}) {
  const { thread } = props;
  // Resolved conversations start folded. The person's own choice holds until the conversation
  // is resolved or reopened, and survives the row scrolling away (`pr-ui-store`).
  const [fold, setFold] = useFold(thread.id);
  const open = fold && fold.resolved === thread.resolved ? fold.open : !thread.resolved;
  const setOpen = (next: boolean) => setFold({ open: next, resolved: thread.resolved });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const state = usePrReview()?.state;
  const first = thread.comments[0];
  const preview = first && previewOf(state, first);
  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const marks = (
    <>
      {thread.outdated && <span className="shrink-0 text-xs text-subtle-foreground">Outdated</span>}
      {thread.resolved && <span className="shrink-0 text-xs text-subtle-foreground">Resolved</span>}
    </>
  );
  return (
    <section
      aria-label={`Conversation on ${threadPlace(thread)}`}
      className={cn("min-w-0 space-y-3 font-sans whitespace-normal", props.className)}
    >
      {(props.place || thread.resolved || thread.outdated) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full min-w-0 items-center gap-2 text-left text-ui text-muted-foreground hover:text-foreground focus-ring"
        >
          <CaretRightIcon
            aria-hidden
            size={12}
            className={cn(
              "shrink-0 text-subtle-foreground transition-transform duration-(--motion-base)",
              open && "rotate-90",
            )}
          />
          {props.place && (
            <span dir="rtl" className="min-w-0 shrink truncate text-left">
              <bdi dir="ltr" className="font-mono text-xs">
                {threadPlace(thread)}
              </bdi>
            </span>
          )}
          {marks}
          {!open && preview && first && (
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">{first.author}</span>{" "}
              <span className={cn(preview.hidden && "text-subtle-foreground")}>{preview.text}</span>
            </span>
          )}
          {!open && thread.comments.length > 1 && (
            <span className="ml-auto shrink-0 text-xs text-subtle-foreground tabular-nums">
              {plural(thread.comments.length, "comment")}
            </span>
          )}
        </button>
      )}
      {open && (
        <>
          <ol className="list-none space-y-3 p-0">
            {thread.comments.map((comment) => (
              <li key={comment.id}>
                <PrComment
                  comment={comment}
                  quoteTarget={`thread:${thread.id}`}
                  outdated={thread.outdated}
                  open={expanded.has(comment.id)}
                  onToggle={() => toggle(comment.id)}
                />
              </li>
            ))}
          </ol>
          {first && (
            <div className="flex flex-wrap items-start gap-2">
              <PrReplyField
                threadId={thread.id}
                rootCommentId={first.id}
                className="min-w-0 flex-1 basis-64"
              />
              <PrResolveButton thread={thread} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
