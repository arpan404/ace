import { useState } from "react";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { cn } from "@/lib/cn.ts";
import { submitBlocked, verdictBlocked } from "@ace/ui-core";
import { lockedText, usePrDetail, usePrIdentity, usePrReview } from "./pr-review-context.tsx";
import { useDraftsFollowHead } from "./pr-review-follow.ts";
import { PrReviewDraftRow } from "./pr-review-draft-row.tsx";

type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const verdicts: readonly { value: Verdict; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

/**
 * "Review" in the pull request's header, with how many line comments wait in the review. It
 * opens the review: a summary, Comment / Approve / Request changes, the pending line comments
 * (each removable), and Submit review, which sends them all as one review.
 */
export function PrReviewButton(props: {
  /** In the Code tab's bar: "Finish review · N", the main action while comments wait. */
  finish?: boolean | undefined;
}) {
  const review = usePrReview();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const detail = usePrDetail();
  const identity = usePrIdentity();
  const draft = useMarkdownDraft(
    identity ? `${draftKeys.prComment(identity.workspaceId, identity.prKey)}:review` : undefined,
  );
  const state = review?.state;
  const follow = useDraftsFollowHead();
  if (!review || !detail || !state) return null;
  const drafts = state.drafts;
  const live = detail.status.state === "open" || detail.status.state === "draft";
  const locked = review.commentsLocked;
  if (!drafts.length && !((state.canComment || locked) && live)) return null;
  const headSha = detail.status.headSha;
  const blocked = verdictBlocked(state, detail.author, live);
  const chosen = blocked && verdict !== "COMMENT" ? "COMMENT" : verdict;
  const disabled = !review.ready || review.pending;
  const empty = chosen !== "APPROVE" && !draft.text.trim() && !drafts.length;
  // Why Submit is off, always in words; the lock says so itself above.
  const why = submitBlocked({
    ready: review.ready,
    writing: review.pending,
    locked,
    canComment: state.canComment,
    headSha,
    stateHead: state.headSha,
    drafts,
    hostedPending: state.hostedPending,
    empty,
  });
  const submit = () => {
    if (why) return;
    const body = draft.text;
    void review
      .run({ kind: "submit", event: chosen, body, headSha, draftIds: drafts.map((d) => d.id) })
      .then((ok) => {
        // Text typed while it posted stays, with the review open to send it.
        if (!ok || !draft.clear(body)) return;
        setVerdict("COMMENT");
        setOpen(false);
      });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={props.finish && drafts.length ? "primary" : "secondary"}
            size={props.finish ? "sm" : "default"}
          />
        }
        aria-label={
          drafts.length
            ? `${props.finish ? "Finish review" : "Review"} · ${drafts.length} pending`
            : undefined
        }
      >
        {props.finish && drafts.length ? "Finish review" : "Review"}
        {drafts.length > 0 && " "}
        {drafts.length > 0 && (
          <span
            className={cn(
              "font-normal tabular-nums",
              props.finish ? "opacity-80" : "text-muted-foreground",
            )}
          >
            {/* A narrow page keeps the count and drops the word; the label still says it. */}
            {`· ${drafts.length}`}
            {!props.finish && <span className="@max-[30rem]/pr:hidden"> pending</span>}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[28rem] max-w-[calc(100vw-1rem)] space-y-3 p-3">
        <PopoverTitle className="text-ui font-medium">Finish your review</PopoverTitle>
        <MarkdownEditor
          autoFocus
          label="Review summary"
          placeholder="Leave a summary"
          maxLength={60_000}
          value={draft.text}
          disabled={locked}
          onChange={draft.setText}
          onSubmit={submit}
        />
        {locked && (
          <p role="status" className="text-xs text-muted-foreground">
            {lockedText}
          </p>
        )}
        <RadioGroup
          aria-label="Review verdict"
          value={chosen}
          onValueChange={(value) => {
            const picked = verdicts.find((v) => v.value === value);
            if (picked) setVerdict(picked.value);
          }}
          className="gap-2"
        >
          {verdicts.map((v) => {
            const off = locked || (v.value !== "COMMENT" && !!blocked);
            return (
              <label
                key={v.value}
                className={cn("flex items-center gap-2 text-ui", off && "opacity-50")}
              >
                <RadioGroupItem value={v.value} disabled={off} />
                {v.label}
              </label>
            );
          })}
        </RadioGroup>
        {blocked && <p className="text-xs text-subtle-foreground">{blocked}</p>}
        {drafts.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {drafts.length === 1 ? "1 pending comment" : `${drafts.length} pending comments`}
            </p>
            <ul className="max-h-72 divide-y divide-border-soft overflow-y-auto">
              {drafts.map((d) => (
                <PrReviewDraftRow key={d.id} draft={d} headSha={headSha} />
              ))}
            </ul>
          </div>
        )}
        {state.hostedPending?.url && (
          <a
            href={state.hostedPending.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-ring"
          >
            Open your pending review on GitHub
          </a>
        )}
        {follow.failed && (
          <p role="status" className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              Couldn't move your pending comments to the new commits.
            </span>
            <Button size="xs" variant="ghost" disabled={disabled} onClick={follow.retry}>
              Try again
            </Button>
          </p>
        )}
        {why && !locked && (
          <p role="status" className="text-xs text-muted-foreground">
            {why}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!!why} onClick={submit}>
            Submit review
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
