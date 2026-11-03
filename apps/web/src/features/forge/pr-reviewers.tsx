import { useState } from "react";
import type { ForgePrReviewers, ForgeReviewAction } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { MessageAvatar } from "@/components/ui/message.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { PrAvatar } from "./pr-presentation.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { reviewerWords, type ReviewerRow } from "@ace/ui-core";

/** The verdict's status colour, on its words only. */
const verdictTone: Record<string, string> = {
  APPROVED: "text-status-done",
  CHANGES_REQUESTED: "text-status-failed",
};

function Face(props: { row: ReviewerRow; className?: string }) {
  const { row } = props;
  return row.kind === "team" ? (
    <MessageAvatar aria-hidden className={cn("self-center text-xs", props.className)}>
      {row.label.slice(0, 1).toUpperCase()}
    </MessageAvatar>
  ) : (
    <PrAvatar name={row.name} url={row.avatarUrl} className={props.className} />
  );
}

/** Each reviewer by name with their latest verdict in words: "mira Changes requested · dana Approved". */
function Names(props: { rows: readonly ReviewerRow[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui">
      {props.rows.map((row, index) => (
        <span key={row.key} className="inline-flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
          )}
          <Face row={row} />
          <span className="text-foreground">{row.label}</span>
          <span
            className={cn(
              "text-xs",
              (row.review && verdictTone[row.review.state]) ?? "text-muted-foreground",
            )}
          >
            {reviewerWords(row).toLowerCase()}
          </span>
        </span>
      ))}
    </span>
  );
}

function DismissForm(props: {
  row: ReviewerRow;
  disabled: boolean;
  onDismiss(message: string): Promise<boolean>;
  onCancel(): void;
}) {
  const [message, setMessage] = useState("");
  const send = async () => {
    if (!message.trim()) return;
    if (await props.onDismiss(message.trim())) props.onCancel();
  };
  return (
    <form
      className="flex flex-col gap-2 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label={`Why dismiss ${props.row.label}'s review`}
        placeholder="Why this review no longer applies"
        maxLength={4096}
        value={message}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the form opens to write this.
        autoFocus
        className="min-h-16"
        onChange={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          variant="primary"
          disabled={props.disabled || !message.trim()}
        >
          Dismiss review
        </Button>
      </div>
    </form>
  );
}

function Row(props: {
  row: ReviewerRow;
  disabled: boolean;
  run(action: ForgeReviewAction): Promise<boolean>;
}) {
  const { row, run } = props;
  const [dismissing, setDismissing] = useState(false);
  const review = row.review;
  const person = row.kind === "user" ? [row.name] : [];
  const team = row.kind === "team" ? [row.name] : [];
  return (
    <li className="border-t border-border py-2 first:border-t-0">
      <div className="flex min-h-7 items-center gap-2">
        <Face row={row} className="size-5 min-w-5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-foreground">{row.label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.kind === "team" ? `Team · ${reviewerWords(row)}` : reviewerWords(row)}
          </span>
        </span>
        {row.canRerequest && (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => void run({ kind: "reviewers.request", reviewers: person })}
          >
            Re-request
          </Button>
        )}
        {row.canRemove && (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            aria-label={`Remove ${row.label} from reviewers`}
            onClick={() =>
              void run({
                kind: "reviewers.remove",
                reviewers: person,
                ...(team.length ? { teams: team } : {}),
              })
            }
          >
            Remove
          </Button>
        )}
        {row.canDismiss && !dismissing && (
          <Button
            size="xs"
            variant="ghost"
            tone="danger"
            disabled={props.disabled}
            aria-label={`Dismiss ${row.label}'s review`}
            onClick={() => setDismissing(true)}
          >
            Dismiss
          </Button>
        )}
      </div>
      {dismissing && review && (
        <DismissForm
          row={row}
          disabled={props.disabled}
          onCancel={() => setDismissing(false)}
          onDismiss={(message) => run({ kind: "review.dismiss", reviewId: review.id, message })}
        />
      )}
    </li>
  );
}

/**
 * The reviewers by name with their verdicts in words, opening their list: each one's latest review, and
 * what this account may do about it (ask again, withdraw a request, dismiss a verdict).
 */
export function PrReviewers(props: {
  rows: readonly ReviewerRow[];
  value: ForgePrReviewers | undefined;
  disabled: boolean;
  /**
   * Read the reviewers again after a dismissal, which may leave the PR itself unchanged.
   * Requests and withdrawals change who the PR asks, and the PR view reads again then.
   */
  onDismissed(): void;
  onRequestReview: (() => void) | undefined;
}) {
  const review = usePrReview();
  const [open, setOpen] = useState(false);
  const busy = props.disabled || !review?.ready || review.pending;
  const run = async (action: ForgeReviewAction) => {
    if (!review) return false;
    const ok = await review.run(action);
    // Called once the write has ended, so this read starts after it.
    if (action.kind === "review.dismiss") props.onDismissed();
    return ok;
  };
  const said = props.rows.map((row) => `${row.label}, ${reviewerWords(row)}`).join("; ");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The list says each verdict once open; until then the tooltip does. */}
      <Tip label={said} disabled={open}>
        <PopoverTrigger
          aria-label={`Reviewers: ${said}`}
          className="-mx-1 inline-flex rounded-sm px-1 py-0.5 text-left focus-ring hover:bg-hover"
        >
          <Names rows={props.rows} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-80 p-3">
        <PopoverTitle className="text-xs font-medium text-muted-foreground">Reviewers</PopoverTitle>
        <ul className="mt-1 flex flex-col">
          {props.rows.map((row) => (
            <Row key={row.key} row={row} disabled={busy} run={run} />
          ))}
        </ul>
        {props.onRequestReview && props.value?.canRequest && (
          <div className="mt-1 flex border-t border-border pt-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => {
                setOpen(false);
                props.onRequestReview?.();
              }}
            >
              Request review
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
