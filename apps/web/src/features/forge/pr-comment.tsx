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
import { usePrDetail, usePrIdentity, usePrReview } from "./pr-review-context.tsx";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";
import { commentFixRequest } from "./pr-summary-model.ts";
import { PrSuggestionActions } from "./pr-suggestions.tsx";
import { useEdit, useFocusAsk } from "./pr-ui-store.tsx";

/** What a comment needs to act: its menu, its edit, and whether it is hidden. */
export type CommentControls = ReturnType<typeof useCommentControls>;

/**
 * A comment's behaviour, apart from how it is drawn: the ⋯ menu's actions, editing in place
 * for the viewer's own, and the fold for a hidden comment. The edit lives above the row, so a
 * row scrolled away and back keeps it (`pr-ui-store`).
 */
export function useCommentControls(comment: ForgeComment, quoteTarget?: QuoteTarget) {
  const review = usePrReview();
  const identity = usePrIdentity();
  const quote = useQuote();
  const state = review?.state;
  const [edit, setEdit, clearIf] = useEdit(`${comment.kind}:${comment.id}`);
  const box = useRef<HTMLDivElement>(null);
  const askFocus = useFocusAsk(`edit:${comment.kind}:${comment.id}`, box);
  const [shown, setShown] = useState(false);
  const reason = hiddenReasonOf(state, comment);
  const own = !!state && comment.author === state.viewer && comment.kind !== "review";
  const source = comment.kind === "review" ? undefined : comment.kind;
  const hideable = canHide(state, comment);
  const disabled = !review?.ready || review.pending;
  const detail = usePrDetail();
  const agent = useFixWithAgent({ workspaceId: identity?.workspaceId ?? "", detail });
  // Only text GitHub says is shown may reach an agent: hidden, or not known yet, stays out.
  const fixable =
    !!detail &&
    (detail.status.state === "open" || detail.status.state === "draft") &&
    Array.isArray(state?.hidden) &&
    reason === undefined &&
    !!comment.body.trim();
  const actions: CommentMenuActions = {
    disabled,
    fix:
      fixable && detail
        ? () =>
            agent.ask(
              commentFixRequest(comment, {
                number: detail.status.ref.number,
                url: detail.status.url,
              }),
            )
        : undefined,
    // Only where the viewer can answer: a quote with no box to take it would be lost.
    quote:
      quote && quoteTarget && state?.canComment && comment.body.trim()
        ? () => quote(quoteTarget, comment.body)
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
  return {
    comment,
    actions,
    prUrl: identity?.url ?? "",
    reason,
    shown,
    setShown,
    edit,
    setEdit,
    save,
    disabled,
    folded,
    box,
  };
}

/** The reaction picker (on hover) and the ⋯ menu, at the end of a comment's heading. */
export function CommentHeadControls(props: { controls: CommentControls }) {
  const { comment, folded } = props.controls;
  return (
    <span className="ml-auto flex shrink-0 items-center">
      {comment.kind !== "review" && !folded && (
        <span className="opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100">
          <PrReactionPicker subject={{ kind: comment.kind, commentId: comment.id }} />
        </span>
      )}
      <PrCommentMenu
        comment={comment}
        prUrl={props.controls.prUrl}
        actions={props.controls.actions}
      />
    </span>
  );
}

/**
 * A comment's text under its heading: the hidden notice with Show, the editor while editing,
 * else the clamped text, a suggestion's commit controls and reactions.
 */
export function CommentContent(props: {
  controls: CommentControls;
  open: boolean;
  onToggle(): void;
  outdated?: boolean | undefined;
  className?: string | undefined;
}) {
  const { comment, reason, shown, setShown, edit, setEdit, save, disabled, folded, box } =
    props.controls;
  return (
    <>
      {reason !== undefined && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-xs text-subtle-foreground",
            props.className,
          )}
        >
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
          <div ref={box} className={cn("mt-1.5 space-y-2", props.className)}>
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
          <div className={cn("space-y-1.5", props.className)}>
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
    </>
  );
}

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
  const controls = useCommentControls(comment, props.quoteTarget);
  const avatar = props.avatar ?? true;
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
        <CommentHeadControls controls={controls} />
      </div>
      <CommentContent
        controls={controls}
        open={props.open}
        onToggle={props.onToggle}
        outdated={props.outdated}
        className={avatar ? "pl-[26px]" : undefined}
      />
    </div>
  );
}
