import { useRef, useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { ForgePrStatus } from "@ace/protocol";
import { useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrComment } from "./pr-comment.tsx";
import { plural, threadPlace } from "./pr-comment-model.ts";
import { appendTo, focusEnd, useQuotedInto } from "./pr-quote.tsx";
import { usePrReview } from "./pr-review-context.tsx";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** Where a reply's unsent text is kept on this device, one per thread. */
export const replyDraftKey = (workspaceId: string, prKey: string, threadId: string) =>
  `pr:${workspaceId}:${prKey}:reply:${threadId}`;

/**
 * A reply to a review thread: one quiet "Reply…" line until chosen, then the Markdown editor
 * with Cancel and Reply. Its text survives reloads; a quote reply opens it with the quote.
 */
export function PrReplyField(props: {
  threadId: string;
  /** GitHub takes replies on the thread's first comment. */
  rootCommentId: number;
  /** Open at once, for a reply asked for elsewhere (a "Reply" beside the comment). */
  startOpen?: boolean;
  /** Called once the reply is posted or cancelled. */
  onDone?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const review = usePrReview();
  const prKey = JSON.stringify(review?.detail.status.ref ?? null);
  const draft = useMarkdownDraft(
    review ? replyDraftKey(review.workspaceId, prKey, props.threadId) : undefined,
  );
  const [open, setOpen] = useState(() => !!props.startOpen || draft.text.trim() !== "");
  const box = useRef<HTMLDivElement>(null);
  useQuotedInto(`thread:${props.threadId}`, (text) => {
    draft.setText(appendTo(draft.text, text));
    setOpen(true);
    focusEnd(box);
  });
  const canComment = !!review?.state?.canComment;
  const disabled = !review?.ready || review.pending || !canComment;
  if (!review?.state || !canComment) return null;
  const send = () => {
    const body = draft.text;
    if (disabled || !body.trim()) return;
    void review.run({ kind: "reply", commentId: props.rootCommentId, body }).then((ok) => {
      if (ok && draft.clear(body)) {
        setOpen(false);
        props.onDone?.();
      }
    });
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-8 w-full items-center rounded-md px-3 text-left text-ui text-subtle-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] hover:text-muted-foreground focus-ring",
          props.className,
        )}
      >
        Reply…
      </button>
    );
  return (
    <div ref={box} className={cn("space-y-2", props.className)}>
      <MarkdownEditor
        autoFocus
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
            setOpen(false);
            props.onDone?.();
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
  const [open, setOpen] = useState(!thread.resolved);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const first = thread.comments[0];
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
          {!open && first && (
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">{first.author}</span>{" "}
              {first.body.split("\n")[0]}
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
          <ol className="space-y-3">
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
                className="min-w-0 flex-1"
              />
              <PrResolveButton thread={thread} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
