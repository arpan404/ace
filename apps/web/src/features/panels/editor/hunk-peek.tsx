// oxlint-disable react/no-array-index-key -- a hunk's lines have no identity but their place.
import { CaretDownIcon, CaretUpIcon } from "@ace/icons";
import type { ChangeHunk } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** What a hunk did, in words: "2 lines changed", "1 line removed", "3 lines added". */
export function hunkSummary(hunk: ChangeHunk): string {
  if (hunk.added.length === 0) return `${plural(hunk.removed.length, "line")} removed`;
  if (hunk.removed.length === 0) return `${plural(hunk.added.length, "line")} added`;
  return `${plural(hunk.added.length, "line")} changed`;
}

/** A hunk under its lines: a line of words and actions, then what it replaced and what is now. */
function PeekFrame(props: {
  hunk: ChangeHunk;
  /** Names the group for assistive tech. */
  label: string;
  words: string;
  actions: ReactNode;
  onClose(): void;
}) {
  const { hunk } = props;
  return (
    <div
      role="group"
      aria-label={props.label}
      data-hunk-peek
      className="border-y border-border bg-background py-1 shadow-sm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div className="flex items-center gap-1.5 px-3 pb-1 font-sans text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{props.words}</span>
        {props.actions}
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

/**
 * A change since the last commit, shown under its lines in the editor: the committed lines it
 * replaced, then what the file has now, with Revert (puts the committed lines back and saves)
 * and Close. Escape closes it too.
 */
export function HunkPeek(props: { hunk: ChangeHunk; onRevert(): void; onClose(): void }) {
  return (
    <PeekFrame
      hunk={props.hunk}
      label={`Change at line ${props.hunk.start}`}
      words={`${hunkSummary(props.hunk)} since the last commit`}
      onClose={props.onClose}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={props.onRevert}>
            Revert
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        </>
      }
    />
  );
}

/**
 * One hunk of a turn under review, under its lines: what the turn replaced and what it wrote,
 * with Keep and Comment, the previous and next change (⇧F7, F7), the turn's diff side by side,
 * and Done. (Reverting a turn is the daemon's to do, against the exact disk version.)
 */
export function ReviewPeek(props: {
  hunk: ChangeHunk;
  /** "Claude Code · turn 2 · 1 of 3". */
  where: string;
  onKeep(): void;
  /** Unset while the thread has no composer to take a comment. */
  onComment?: (() => void) | undefined;
  onStep(direction: 1 | -1): void;
  /** Show the turn's diff of the file side by side instead. */
  onSideBySide?: (() => void) | undefined;
  onDone(): void;
}) {
  return (
    <PeekFrame
      hunk={props.hunk}
      label={`Review change at line ${props.hunk.start}`}
      words={`${props.where} · ${hunkSummary(props.hunk)}`}
      onClose={props.onDone}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={props.onKeep}>
            Keep
          </Button>
          {props.onComment && (
            <Button size="sm" variant="ghost" onClick={props.onComment}>
              Comment
            </Button>
          )}
          <IconButton
            icon={CaretUpIcon}
            size="sm"
            label="Previous change"
            keys="⇧F7"
            onClick={() => props.onStep(-1)}
          />
          <IconButton
            icon={CaretDownIcon}
            size="sm"
            label="Next change"
            keys="F7"
            onClick={() => props.onStep(1)}
          />
          {props.onSideBySide && (
            <Button size="sm" variant="ghost" onClick={props.onSideBySide}>
              Side by side
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={props.onDone}>
            Done
          </Button>
        </>
      }
    />
  );
}

/**
 * A review with no change of its turn left to show in this file (all kept, or edited away): what
 * that means, in words, and Done to end it.
 */
export function ReviewIdle(props: { words: string; onDone(): void }) {
  return (
    <div
      role="status"
      aria-label="Review"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{props.words}</span>
      <Button size="sm" variant="ghost" onClick={props.onDone}>
        Done
      </Button>
    </div>
  );
}
