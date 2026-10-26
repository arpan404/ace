import { useRef, useState, type ReactNode } from "react";
import { authoredReviewComment } from "@ace/forge/review-comment-body";
import type { ForgeComment } from "@ace/protocol";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { PrClampedText } from "./pr-clamped.tsx";
import { PrCommentMenu, type CommentMenuActions } from "./pr-comment-menu.tsx";
import { canHide, hiddenReasonOf, hiddenWord } from "@ace/ui-core";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import { useQuote, type QuoteTarget } from "./pr-quote.tsx";
import { PrReactionPicker, PrReactions } from "./pr-reactions.tsx";
import { usePrIdentity, usePrReview } from "./pr-review-context.tsx";
import { PrSuggestionActions } from "./pr-suggestions.tsx";
import { useEdit, useFocusAsk } from "./pr-ui-store.tsx";

/**
 * One comment wherever the PR shows it: who said it and when, its text (clamped), its
 * suggestion's commit controls, reactions, and a ⋯ menu on hover. The viewer's own comments
 * edit in place; a hidden comment folds to one line naming why until it is shown.
 */
export function PrComment(props: {
  comment: ForgeComment;
  /** Words after the author: "commented", a review verdict. */
  words?: ReactNode;
  /** Trailing heading detail, such as the file and line in a list of comments. */
  place?: ReactNode;
  /** Off for rows whose avatar already sits on a rail beside them. */
  avatar?: boolean;
  /** Where Quote reply sends the text; without one there is no Quote reply. */
  quoteTarget?: QuoteTarget | undefined;
  /** A suggestion no longer on the current diff can't be committed. */
  outdated?: boolean;
  open: boolean;
  onToggle(): void;
}) {
  const { comment } = props;
  const review = usePrReview();
  const identity = usePrIdentity();
  const quote = useQuote();
  const state = review?.state;
  // The edit lives above the row, so a row scrolled away and back keeps it (`pr-ui-store`).
  const [edit, setEdit, clearIf] = useEdit(`${comment.kind}:${comment.id}`);
  const box = useRef<HTMLDivElement>(null);
  const askFocus = useFocusAsk(`edit:${comment.kind}:${comment.id}`, box);
  const [shown, setShown] = useState(false);
  const avatar = props.avatar ?? true;
  const reason = hiddenReasonOf(state, comment);
  const own = !!state && comment.author === state.viewer && comment.kind !== "review";
  const source = comment.kind === "review" ? undefined : comment.kind;
  const hideable = canHide(state, comment);
  const disabled = !review?.ready || review.pending;
  const actions: CommentMenuActions = {
    disabled,
    // Only where the viewer can answer: a quote with no box to take it would be lost.
    quote:
      quote && props.quoteTarget && state?.canComment && comment.body.trim()
        ? () => props.quoteTarget && quote(props.quoteTarget, comment.body)
        : undefined,
    edit:
      own && source
        ? () => {
            setShown(true);
            setEdit({ body: authoredReviewComment(comment.body), expectedBody: comment.body });
            askFocus();
          }
        : undefined,
    remove:
      own && source
        ? () =>
            void review?.run({
              kind: "comment.delete",
              source,
              commentId: comment.id,
              expectedBody: comment.body,
            })
        : undefined,
    hide:
      hideable && source && reason === undefined
        ? (why) =>
            void review?.run({ kind: "comment.hide", source, commentId: comment.id, reason: why })
        : undefined,
    unhide:
      hideable && source && reason !== undefined
        ? () => void review?.run({ kind: "comment.unhide", source, commentId: comment.id })
        : undefined,
  };
  const save = () => {
    if (!edit || !source || !edit.body.trim() || disabled) return;
    const sent = edit;
    void review
      ?.run({
        kind: "comment.edit",
        source,
        commentId: comment.id,
        expectedBody: sent.expectedBody,
        body: sent.body,
      })
      .then((ok) => {
        // Text changed while it saved stays open to save again.
        if (ok) clearIf(sent);
      });
  };
  const folded = reason !== undefined && !shown && !edit;
  const indent = avatar ? "pl-[26px]" : undefined;
  return (
    <div className="group/comment min-w-0" data-comment-id={`${comment.kind}:${comment.id}`}>
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
        {avatar && <PrAvatar name={comment.author} url={comment.authorAvatarUrl} />}
        <span className="truncate font-medium text-foreground">{comment.author}</span>
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
        <span className="ml-auto flex shrink-0 items-center">
          {comment.kind !== "review" && !folded && (
            <span className="opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100">
              <PrReactionPicker subject={{ kind: comment.kind, commentId: comment.id }} />
            </span>
          )}
          <PrCommentMenu comment={comment} prUrl={identity?.url ?? ""} actions={actions} />
        </span>
      </div>
      {reason !== undefined && (
        <p className={cn("flex items-center gap-1.5 text-xs text-subtle-foreground", indent)}>
          {`Hidden as ${hiddenWord(reason)}`}
          <span aria-hidden>·</span>
          <button
            type="button"
            aria-expanded={shown}
            onClick={() => setShown(!shown)}
            className="text-link hover:underline focus-ring"
          >
            {shown ? "Hide" : "Show"}
          </button>
        </p>
      )}
      {!folded &&
        (edit ? (
          <div ref={box} className={cn("mt-1.5 space-y-2", indent)}>
            <MarkdownEditor
              label="Edit comment"
              disabled={disabled}
              value={edit.body}
              onChange={(body) => setEdit({ ...edit, body })}
              onSubmit={save}
              maxLength={60_000}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEdit(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={disabled || !edit.body.trim()} onClick={save}>
                Update comment
              </Button>
            </div>
          </div>
        ) : (
          <div className={cn("space-y-1.5", indent)}>
            {comment.body.trim() && (
              <div className="mt-0.5">
                <PrClampedText
                  text={comment.body}
                  comment={comment}
                  open={props.open}
                  onToggle={props.onToggle}
                />
              </div>
            )}
            <PrSuggestionActions comment={comment} outdated={props.outdated ?? false} />
            {comment.kind !== "review" && (
              <PrReactions subject={{ kind: comment.kind, commentId: comment.id }} onlyWhenAny />
            )}
          </div>
        ))}
    </div>
  );
}
