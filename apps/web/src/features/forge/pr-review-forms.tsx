import { useRef, useState } from "react";
import { z } from "zod";
import type { ForgeComment, ForgePrDetail, ForgeReviewAnchor } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { usePrReview } from "./pr-review-context.tsx";
export function useReviewText(key: string, initial = "") {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? z.string().max(60_000).parse(JSON.parse(raw)) : initial;
    } catch {
      return initial;
    }
  });
  const current = useRef(value);
  const save = (text: string) => {
    current.current = text;
    setValue(text);
    try {
      localStorage.setItem(key, JSON.stringify(text));
    } catch {
      /* Daemon drafts remain durable when browser storage is unavailable. */
    }
  };
  const clearSubmitted = (submitted: string): boolean => {
    if (current.current !== submitted) return false;
    save("");
    return true;
  };
  return [value, save, clearSubmitted] as const;
}
export function PrReviewSubmission({ detail }: { detail: ForgePrDetail }) {
  const review = usePrReview();
  const key = `ace:hosted-review:${JSON.stringify(detail.status.ref)}:${detail.status.headSha}`;
  const [body, setBody, clearSubmitted] = useReviewText(key);
  const drafts = review?.state?.drafts ?? [];
  const outdated = drafts.some((d) => d.anchor.commit !== detail.status.headSha);
  return (
    <section aria-label="Submit GitHub review" className="space-y-3 border-t border-border pt-4">
      <h3 className="font-medium">GitHub review</h3>
      <Textarea
        aria-label="Review summary"
        maxLength={60_000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <ul>
        {drafts.map((draft) => (
          <li key={draft.id} className="py-2">
            <p>
              {draft.anchor.path}:{draft.anchor.startLine ? `${draft.anchor.startLine}–` : ""}
              {draft.anchor.line} ({draft.anchor.side})
              {draft.anchor.commit !== detail.status.headSha
                ? " · Outdated anchor — remove and re-anchor on the current diff"
                : " · Unsent draft"}
            </p>
            <p className="whitespace-pre-wrap">{draft.body}</p>
            <Button
              disabled={review?.pending}
              onClick={() => void review?.run({ kind: "draft.delete", id: draft.id })}
            >
              Remove draft
            </Button>
          </li>
        ))}
      </ul>
      {outdated && (
        <p role="status">
          New commits made draft anchors outdated. Re-anchor them before submitting.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((event) => (
          <Button
            key={event}
            disabled={
              !review?.ready ||
              review.pending ||
              !review.state ||
              outdated ||
              review.state.headSha !== detail.status.headSha ||
              (event !== "COMMENT" && !review.state.canReview) ||
              !review.state.canComment ||
              (event !== "APPROVE" && !body.trim() && !drafts.length)
            }
            onClick={() =>
              void review
                ?.run({
                  kind: "submit",
                  event,
                  body,
                  headSha: detail.status.headSha,
                  draftIds: drafts.map((d) => d.id),
                })
                .then((ok) => {
                  if (ok) clearSubmitted(body);
                })
            }
          >
            {event === "COMMENT"
              ? "Submit comment review"
              : event === "APPROVE"
                ? "Approve on GitHub"
                : "Request changes on GitHub"}
          </Button>
        ))}
      </div>
    </section>
  );
}
export function PrInlineDraft(props: {
  prKey: string;
  anchor: ForgeReviewAnchor;
  onClose(): void;
}) {
  const review = usePrReview();
  const [body, setBody, clearSubmitted] = useReviewText(
    `ace:inline:${props.prKey}:${JSON.stringify(props.anchor)}`,
  );
  const [id] = useState(() => crypto.randomUUID());
  return (
    <form
      className="space-y-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void review
          ?.run({ kind: "draft.save", draft: { id, anchor: props.anchor, body } })
          .then((ok) => {
            if (ok && clearSubmitted(body)) props.onClose();
          });
      }}
    >
      <p>
        Unsent inline comment · {props.anchor.side} {props.anchor.startLine ?? props.anchor.line}–
        {props.anchor.line}
      </p>
      <Textarea
        aria-label="Inline comment draft"
        maxLength={60_000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <Button type="submit" disabled={!review?.ready || review.pending || !body.trim()}>
        Save review draft
      </Button>
      <Button type="button" onClick={props.onClose}>
        Cancel
      </Button>
    </form>
  );
}
export function PrConversationComposer(props: { prKey: string; replyTo?: number | undefined }) {
  const review = usePrReview();
  const [body, setBody, clearSubmitted] = useReviewText(
    `ace:conversation:${props.prKey}:${props.replyTo ?? "new"}`,
  );
  return (
    <form
      className="space-y-2 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void review
          ?.run(
            props.replyTo
              ? { kind: "reply", commentId: props.replyTo, body }
              : { kind: "conversation", body },
          )
          .then((ok) => {
            if (ok) clearSubmitted(body);
          });
      }}
    >
      <Textarea
        aria-label={props.replyTo ? "Reply to review thread" : "PR conversation comment"}
        maxLength={60_000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <Button
        type="submit"
        disabled={!review?.ready || review.pending || !review.state?.canComment || !body.trim()}
      >
        {props.replyTo ? "Post reply" : "Post conversation comment"}
      </Button>
    </form>
  );
}
export function PrOwnComment({ comment }: { comment: ForgeComment }) {
  const review = usePrReview();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  if (!review?.state || comment.author !== review.state.viewer || comment.kind === "review")
    return null;
  const source = comment.kind;
  return (
    <div className="space-y-2">
      {editing && (
        <Textarea
          aria-label="Edit GitHub comment"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={60_000}
        />
      )}
      <Button
        disabled={review.pending}
        onClick={() => {
          if (!editing) setEditing(true);
          else
            void review
              .run({
                kind: "comment.edit",
                source,
                commentId: comment.id,
                expectedBody: comment.body,
                body,
              })
              .then((ok) => {
                if (ok) setEditing(false);
              });
        }}
      >
        {editing ? "Save comment" : "Edit comment"}
      </Button>
      <Button
        disabled={review.pending}
        onClick={() => {
          if (window.confirm("Delete this GitHub comment?"))
            void review.run({
              kind: "comment.delete",
              source,
              commentId: comment.id,
              expectedBody: comment.body,
            });
        }}
      >
        Delete comment
      </Button>
    </div>
  );
}
export function PrThreadControls(props: {
  id: string;
  resolved: boolean;
  replyTo?: number | undefined;
  prKey: string;
}) {
  const review = usePrReview();
  return (
    <div>
      <Button
        disabled={
          !review?.ready || review.pending || !review.state?.resolvableThreads.includes(props.id)
        }
        onClick={() =>
          void review?.run({
            kind: props.resolved ? "thread.unresolve" : "thread.resolve",
            threadId: props.id,
          })
        }
      >
        {props.resolved ? "Unresolve thread" : "Resolve thread"}
      </Button>
      {props.replyTo && <PrConversationComposer prKey={props.prKey} replyTo={props.replyTo} />}
    </div>
  );
}
