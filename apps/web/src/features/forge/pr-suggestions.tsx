import { useState } from "react";
import { suggestionOf } from "@ace/forge/suggestions";
import type { ForgeComment } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { usePrReview } from "./pr-review-context.tsx";

/** Asks for the commit message, then commits the suggestions on the head the review saw. */
function CommitSuggestions(props: {
  open: boolean;
  commentIds: readonly number[];
  message: string;
  onClose(): void;
  onCommitted?(): void;
}) {
  const review = usePrReview();
  const [message, setMessage] = useState(props.message);
  const headSha = review?.state?.headSha;
  const count = props.commentIds.length;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!review || !headSha || !message.trim()) return;
            props.onClose();
            void review
              .run({
                kind: "suggestions.apply",
                headSha,
                commentIds: [...props.commentIds],
                message,
              })
              .then((ok) => {
                if (ok) props.onCommitted?.();
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {count === 1 ? "Commit suggestion" : `Commit ${count} suggestions`}
            </DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Commit message"
            value={message}
            maxLength={4096}
            onChange={(e) => setMessage(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!review?.ready || review.pending || !headSha || !message.trim()}
            >
              Commit changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Commit or batch an inline comment's suggested change. Shown only for a suggestion still on
 * the current diff; GitHub refuses the commit if the head moved since the review was read.
 */
export function PrSuggestionActions(props: { comment: ForgeComment; outdated: boolean }) {
  const review = usePrReview();
  const [open, setOpen] = useState(false);
  const { comment } = props;
  if (!review?.state || comment.kind !== "inline" || props.outdated) return null;
  if (!suggestionOf(comment.body)) return null;
  const batched = review.batch.includes(comment.id);
  const disabled = !review.ready || review.pending;
  return (
    <div className="flex items-center gap-1">
      <Button size="xs" disabled={disabled} onClick={() => setOpen(true)}>
        Commit suggestion
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-pressed={batched}
        disabled={disabled}
        onClick={() => review.toggleBatch(comment.id)}
      >
        {batched ? "Remove from batch" : "Add to batch"}
      </Button>
      {open && (
        <CommitSuggestions
          open
          commentIds={[comment.id]}
          message={`Apply suggestion from @${comment.author}`}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The batched suggestions, committed together as one commit or cleared. */
export function PrSuggestionBatch() {
  const review = usePrReview();
  const [open, setOpen] = useState(false);
  if (!review || !review.batch.length) return null;
  const count = review.batch.length;
  return (
    <div
      role="group"
      aria-label="Suggestion batch"
      className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 text-xs"
    >
      <span className="text-muted-foreground tabular-nums">
        {count === 1 ? "1 suggestion in batch" : `${count} suggestions in batch`}
      </span>
      <span className="flex items-center gap-1">
        <Button size="xs" variant="ghost" onClick={review.clearBatch}>
          Clear batch
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!review.ready || review.pending}
          onClick={() => setOpen(true)}
        >
          {count === 1 ? "Commit suggestion" : `Commit ${count} suggestions`}
        </Button>
      </span>
      {open && (
        <CommitSuggestions
          open
          commentIds={review.batch}
          message="Apply suggestions from code review"
          onClose={() => setOpen(false)}
          onCommitted={review.clearBatch}
        />
      )}
    </div>
  );
}
