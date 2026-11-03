import type { ForgeReviewDraft } from "@ace/protocol";
import { draftPlace, draftStanding } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { PrEarlierCode } from "./pr-earlier-code.tsx";
import { usePrReview } from "./pr-review-context.tsx";

/**
 * One pending comment in Finish your review: where it is, its first line, and Remove. One a
 * push left behind also shows the code it was written on and offers Post on file, which sends
 * it at once as a comment on its file, quoting that code.
 */
export function PrReviewDraftRow(props: { draft: ForgeReviewDraft; headSha: string }) {
  const review = usePrReview();
  const { draft, headSha } = props;
  const standing = draftStanding(draft, headSha);
  const disabled = !review?.ready || review.pending;
  const code = draft.outdated?.code ?? [];
  return (
    <li className="space-y-1.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
            <span dir="rtl" className="min-w-0 truncate text-left">
              <bdi dir="ltr" className="font-mono">
                {draftPlace(draft.anchor)}
              </bdi>
            </span>
            {standing === "outdated" && (
              <span className="shrink-0 text-status-needs-you">Lines changed</span>
            )}
            {standing === "moving" && <span className="shrink-0">Moving to new commits</span>}
          </p>
          <p className="truncate text-ui">{draft.body.split("\n")[0]}</p>
        </div>
        {standing === "outdated" && (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void review?.run({ kind: "draft.file", id: draft.id, headSha })}
          >
            Post on file
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => void review?.run({ kind: "draft.delete", id: draft.id })}
        >
          Remove
        </Button>
      </div>
      {standing === "outdated" && code.length > 0 && (
        <PrEarlierCode
          label={`Code at ${draft.anchor.commit.slice(0, 7)}`}
          rows={code.map((text, index) => ({
            key: `${index}`,
            kind: " ",
            text,
            // The kept code ends at the draft's line.
            [draft.anchor.side === "LEFT" ? "left" : "right"]:
              draft.anchor.line - (code.length - 1 - index),
            // The draft's own lines end the kept code.
            commented:
              index >=
              code.length - (draft.anchor.line - (draft.anchor.startLine ?? draft.anchor.line) + 1),
          }))}
        />
      )}
    </li>
  );
}
