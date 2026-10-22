import { useState } from "react";
import type { ForgeReviewState } from "@ace/protocol";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { draftKeys, useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { cn } from "@/lib/cn.ts";
import { draftPlace } from "./pr-comment-model.ts";
import { lockedText, usePrDetail, usePrIdentity, usePrReview } from "./pr-review-context.tsx";

type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const verdicts: readonly { value: Verdict; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

/** Why the viewer can't give a verdict here, or undefined when they can. */
export function verdictBlocked(
  state: Pick<ForgeReviewState, "viewer" | "canReview">,
  author: string,
  open: boolean,
): string | undefined {
  if (state.viewer === author)
    return "You can't approve or request changes on your own pull request.";
  if (!open) return "Only an open pull request takes an approval or a change request.";
  if (!state.canReview) return "GitHub doesn't let this account approve this pull request.";
  return undefined;
}

/**
 * "Review" in the pull request's header, with how many line comments wait in the review. It
 * opens the review: a summary, Comment / Approve / Request changes, the pending line comments
 * (each removable), and Submit review, which sends them all as one review.
 */
export function PrReviewButton() {
  const review = usePrReview();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const detail = usePrDetail();
  const identity = usePrIdentity();
  const draft = useMarkdownDraft(
    identity ? `${draftKeys.prComment(identity.workspaceId, identity.prKey)}:review` : undefined,
  );
  const state = review?.state;
  if (!review || !detail || !state) return null;
  const drafts = state.drafts;
  const live = detail.status.state === "open" || detail.status.state === "draft";
  const locked = review.commentsLocked;
  if (!drafts.length && !((state.canComment || locked) && live)) return null;
  const headSha = detail.status.headSha;
  const outdated = drafts.filter((d) => d.anchor.commit !== headSha);
  const blocked = verdictBlocked(state, detail.author, live);
  const chosen = blocked && verdict !== "COMMENT" ? "COMMENT" : verdict;
  const disabled = !review.ready || review.pending;
  const refused = locked || !state.canComment;
  const empty = chosen !== "APPROVE" && !draft.text.trim() && !drafts.length;
  const stale = state.headSha !== headSha;
  const submit = () => {
    if (disabled || empty || outdated.length || stale || refused) return;
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
        render={<Button variant="secondary" />}
        aria-label={drafts.length ? `Review · ${drafts.length} pending` : undefined}
      >
        Review
        {drafts.length > 0 && " "}
        {drafts.length > 0 && (
          <span className="font-normal text-muted-foreground tabular-nums">
            {/* A narrow page keeps the count and drops the word; the label still says it. */}
            {`· ${drafts.length}`}
            <span className="@max-[30rem]/pr:hidden"> pending</span>
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
            <ul className="max-h-48 divide-y divide-border-soft overflow-y-auto">
              {drafts.map((d) => (
                <li key={d.id} className="flex min-w-0 items-center gap-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
                      <span dir="rtl" className="min-w-0 truncate text-left">
                        <bdi dir="ltr" className="font-mono">
                          {draftPlace(d.anchor)}
                        </bdi>
                      </span>
                      {d.anchor.commit !== headSha && (
                        <span className="shrink-0 text-status-needs-you">Outdated</span>
                      )}
                    </p>
                    <p className="truncate text-ui">{d.body.split("\n")[0]}</p>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void review.run({ kind: "draft.delete", id: d.id })}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {outdated.length > 0 && (
          <p role="status" className="text-xs text-muted-foreground">
            New commits moved the lines of outdated comments. Remove them to submit.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={disabled || empty || outdated.length > 0 || stale || refused}
            onClick={submit}
          >
            Submit review
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
