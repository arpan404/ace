import type { LiveFact } from "./live-status.ts";
import type { RowAttention } from "./row-attention.ts";
import { rowStatusLook, waitingOnAgentsLabel } from "./row-status-display.ts";
import type { Tone } from "./status.ts";

/*
 * The hover card's first line under the title: what the thread waits on, in plain words, from
 * the same attention the row draws (`rowStatusLook`), so the two never disagree. Pure.
 */

export interface HoverStatusLine {
  /** "Waiting for approval", "Has a question", "Working"; undefined for a thread at rest. */
  sentence: string | undefined;
  /** What the sentence is about, when the list knows it: a command, a step. */
  detail: { text: string; code: boolean } | undefined;
  /** The words' colour: only what needs the person or a fresh failure is coloured. */
  ink: "warning" | "destructive" | "muted";
}

const muted = (sentence: string | undefined, detail?: HoverStatusLine["detail"]) => ({
  sentence,
  detail,
  ink: "muted" as const,
});

/**
 * The hover card's status sentence for a row. `fact` is what the thread list's live hints say
 * beyond the status (`threadLiveFact`): the tests it runs, the command it watches. How many
 * agents it waits on is the card's own count (`status.waitingOn`), as the row's mark shows.
 */
export function hoverStatusLine(input: {
  attention: RowAttention;
  card: { status: { label: string; tone: Tone; waitingOn?: number | undefined } };
  fact: LiveFact | undefined;
}): HoverStatusLine {
  const { attention, card, fact } = input;
  const look = rowStatusLook(attention, card);
  switch (attention.level) {
    case "needs-you": {
      const sentence = (() => {
        if (look.icon === "approve" && look.word === "Approval") return "Waiting for approval";
        if (look.icon === "question") return "Has a question";
        if (look.icon === "model") return "Choose a model to start";
        if (look.word === "Review") return "Waiting for your review";
        if (fact?.kind === "child-asking") return `${fact.agent} needs you`;
        return look.meaning;
      })();
      return { sentence, detail: undefined, ink: "warning" };
    }
    case "failed": {
      // A failure's own wording ("Unresponsive") is its reason; plain "Failed" adds nothing.
      const reason = card.status.label === "Failed" ? undefined : card.status.label;
      return {
        sentence: "Failed",
        detail: reason ? { text: reason, code: false } : undefined,
        ink: "destructive",
      };
    }
    case "active":
      if (card.status.waitingOn !== undefined)
        return muted(waitingOnAgentsLabel(card.status.waitingOn));
      return active(attention, card.status.label, fact);
    case "done-unread":
      return muted("Finished");
    case "failed-seen":
      return muted("Failed");
    case "syncing":
      return muted(attention.word);
    case "quiet":
      return muted(undefined);
  }
}

function active(
  attention: RowAttention,
  label: string,
  fact: LiveFact | undefined,
): HoverStatusLine {
  if (attention.tone === "working")
    return muted(
      "Working",
      fact?.kind === "tests" ? { text: "Running tests", code: false } : undefined,
    );
  if (attention.tone === "background")
    return muted(
      "Running in background",
      fact?.kind === "watching" && fact.title ? { text: fact.title, code: true } : undefined,
    );
  return muted(label);
}
