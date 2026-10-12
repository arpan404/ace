import { useMemo, useState } from "react";
import { hostedDiffLines } from "@ace/forge/review-anchor";
import type { ForgePrRef, ForgeReviewAnchor } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { PrInlineDraft } from "./pr-review-forms.tsx";
import { usePrReview } from "./pr-review-context.tsx";
export function PrReviewDiff(props: {
  pr: ForgePrRef;
  path: string;
  patch: string;
  headSha: string;
}) {
  const review = usePrReview();
  const rows = useMemo(() => hostedDiffLines(props.patch), [props.patch]);
  const [anchor, setAnchor] = useState<ForgeReviewAnchor>();
  const select = (line: number, side: "LEFT" | "RIGHT", range: boolean) => {
    setAnchor({
      commit: props.headSha,
      path: props.path,
      line,
      side,
      ...(range && anchor?.side === side && anchor.line <= line
        ? { startLine: anchor.line, startSide: side }
        : {}),
    });
  };
  return (
    <div>
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        Select a line number to draft a comment. Shift-select an end line for a range.
      </p>
      <div className="max-h-[60vh] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {rows.map((row) => (
          <div
            key={`${row.left}:${row.right}:${row.text}`}
            className="flex min-w-max whitespace-pre"
          >
            {(["LEFT", "RIGHT"] as const).map((side) => {
              const line = side === "LEFT" ? row.left : row.right;
              return (
                <button
                  type="button"
                  key={side}
                  className="w-12 shrink-0 text-muted-foreground focus-ring"
                  disabled={!line || !review?.state?.canComment}
                  aria-label={line ? `Comment on ${props.path} ${side} line ${line}` : undefined}
                  onClick={(e) => {
                    if (line) select(line, side, e.shiftKey);
                  }}
                >
                  {line ?? ""}
                </button>
              );
            })}
            <code>{row.text}</code>
          </div>
        ))}
      </div>
      {anchor && (
        <PrInlineDraft
          key={JSON.stringify(anchor)}
          prKey={JSON.stringify(props.pr)}
          anchor={anchor}
          onClose={() => setAnchor(undefined)}
        />
      )}
    </div>
  );
}
export function usePrViewedFile(props: { path: string; headSha: string }) {
  const review = usePrReview();
  const file = review?.state?.viewed?.find((f) => f.path === props.path);
  return {
    file,
    disabled: !review?.ready || review.pending || review.state?.headSha !== props.headSha,
    change: () =>
      review?.run({
        kind: file?.state === "VIEWED" ? "file.unview" : "file.view",
        path: props.path,
        headSha: props.headSha,
      }),
  };
}
export function PrViewedFile(props: { path: string; headSha: string }) {
  const { file, disabled, change } = usePrViewedFile(props);
  if (!file)
    return (
      <p className="px-3 text-xs text-muted-foreground">
        GitHub viewed state unavailable; no local-only mark is being shown.
      </p>
    );
  return (
    <Button disabled={disabled} onClick={() => void change()}>
      {file.state === "VIEWED"
        ? "Viewed on GitHub · Mark unviewed"
        : `${file.state === "DISMISSED" ? "Viewed mark outdated · " : ""}Mark viewed on GitHub`}
    </Button>
  );
}

export function PrViewedCheckbox(props: { path: string; headSha: string; disabled: boolean }) {
  const { file, disabled, change } = usePrViewedFile(props);
  if (!file)
    return <p className="px-2 text-xs text-muted-foreground">GitHub viewed state unavailable</p>;
  return (
    <label className="flex shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        className="size-4 rounded-sm focus-ring"
        aria-label={`Viewed ${props.path}`}
        checked={file.state === "VIEWED"}
        disabled={props.disabled || disabled}
        onChange={() => void change()}
      />
      {file.state === "DISMISSED" ? "Viewed mark outdated" : "Viewed"}
    </label>
  );
}
