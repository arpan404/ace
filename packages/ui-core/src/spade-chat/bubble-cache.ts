import {
  spadeBubblePass,
  spadeBubblesFinish,
  spadeBubbleStep,
  type SpadeBubble,
  type SpadeBubblePass,
} from "./bubbles.ts";
import type { SpadeEntry } from "./fold.ts";
import type { SpadeView } from "./view.ts";

/*
 * A conversation's bubbles as it changes, worked out again only from the first entry that
 * changed. The fold replaces an entry whenever it changes, never edits one, and an entry's
 * bubbles depend only on the entries before it and the open approvals (`SpadeBubblePass`), so a
 * reply's live words cost the work of that one reply, not of the whole history. The bubbles
 * before it are the same objects as last time, so a caller can keep what it made of each.
 * Gives what `spadeBubbles` gives for the same view.
 */

/**
 * Where the pass stood before one entry: only what it carries from entry to entry, never the view
 * it was made for, so the marks of a long chat stay one small record per entry.
 */
interface Mark {
  held: { paths: readonly string[]; key: string | undefined };
  recalled: readonly string[];
  inputs: boolean;
  onlyBeats: boolean;
  onlyGroups: boolean;
  count: number;
  /** How many requests had been placed (`SpadeBubblePass.shown`). */
  shown: number;
}

export class SpadeBubbleCache {
  private entries: readonly SpadeEntry[] = [];
  /** The approvals the marks were made with: any change works everything out again. */
  private approvals: string | undefined;
  private made: SpadeBubble[] = [];
  /** The requests placed, in order: each mark's are a prefix of these. */
  private shown: string[] = [];
  /** Before each entry, and after the last. */
  private marks: Mark[] = [];

  bubbles(view: SpadeView): SpadeBubble[] {
    const approvals = JSON.stringify(view.approvals);
    let from = 0;
    if (approvals === this.approvals) {
      const same = Math.min(view.entries.length, this.entries.length);
      while (from < same && view.entries[from] === this.entries[from]) from++;
    }
    const mark = from > 0 ? this.marks[from] : undefined;
    const pass = mark ? resume(mark, this.shown, view) : spadeBubblePass(view);
    this.made.length = mark?.count ?? 0;
    this.marks.length = from;
    for (let index = from; index < view.entries.length; index++) {
      this.marks.push(markOf(pass, this.made.length));
      const entry = view.entries[index];
      if (entry) spadeBubbleStep(pass, this.made, entry);
    }
    const end = markOf(pass, this.made.length);
    this.marks.push(end);
    this.shown = pass.shown;
    this.entries = view.entries;
    this.approvals = approvals;
    // The closing bubbles are worked out on copies, so the next view resumes from the marks.
    return spadeBubblesFinish(resume(end, pass.shown, view), this.made.slice(), view);
  }
}

/** The pass as it stands, kept apart from the one that goes on. */
function markOf(pass: SpadeBubblePass, count: number): Mark {
  return {
    held: { paths: pass.held.paths.slice(), key: pass.held.key },
    recalled: pass.recalled,
    inputs: pass.inputs,
    onlyBeats: pass.onlyBeats,
    onlyGroups: pass.onlyGroups,
    count,
    shown: pass.shown.length,
  };
}

/** A pass that goes on from `mark`, for `view`. */
function resume(mark: Mark, shown: readonly string[], view: SpadeView): SpadeBubblePass {
  return {
    ...spadeBubblePass(view),
    held: { paths: mark.held.paths.slice(), key: mark.held.key },
    recalled: mark.recalled,
    inputs: mark.inputs,
    onlyBeats: mark.onlyBeats,
    onlyGroups: mark.onlyGroups,
    shown: shown.slice(0, mark.shown),
  };
}
