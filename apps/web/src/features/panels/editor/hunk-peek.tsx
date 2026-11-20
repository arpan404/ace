// oxlint-disable react/no-array-index-key -- a hunk's lines have no identity but their place.
import type { ChangeHunk } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** What a hunk did, in words: "2 lines changed", "1 line removed", "3 lines added". */
export function hunkSummary(hunk: ChangeHunk): string {
  if (hunk.added.length === 0) return `${plural(hunk.removed.length, "line")} removed`;
  if (hunk.removed.length === 0) return `${plural(hunk.added.length, "line")} added`;
  return `${plural(hunk.added.length, "line")} changed`;
}

/**
 * A change since the last commit, shown under its lines in the editor: the committed lines it
 * replaced, then what the file has now, with Revert (puts the committed lines back and saves)
 * and Close. Escape closes it too.
 */
export function HunkPeek(props: { hunk: ChangeHunk; onRevert(): void; onClose(): void }) {
  const { hunk } = props;
  return (
    <div
      role="group"
      aria-label={`Change at line ${hunk.start}`}
      data-hunk-peek
      className="border-y border-border bg-background py-1 shadow-sm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div className="flex items-center gap-1.5 px-3 pb-1 font-sans text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{hunkSummary(hunk)} since the last commit</span>
        <Button size="sm" variant="secondary" onClick={props.onRevert}>
          Revert
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div className="max-h-60 overflow-auto">
        {hunk.removed.map((text, index) => (
          <div
            key={`removed-${index}`}
            data-hunk-line="removed"
            className="bg-[color-mix(in_oklab,var(--status-failed)_14%,transparent)] px-3 whitespace-pre"
          >
            <span aria-hidden className="text-subtle-foreground select-none">
              −{" "}
            </span>
            {text}
          </div>
        ))}
        {hunk.added.map((text, index) => (
          <div
            key={`added-${index}`}
            data-hunk-line="added"
            className="bg-[color-mix(in_oklab,var(--status-done)_14%,transparent)] px-3 whitespace-pre"
          >
            <span aria-hidden className="text-subtle-foreground select-none">
              +{" "}
            </span>
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
