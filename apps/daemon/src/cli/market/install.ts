import type {
  MarketInstalled,
  MarketOperation,
  MarketReview,
  MarketReviewItem,
} from "@ace/protocol/marketplace";
import { CliFailure } from "../output.ts";
import { installQuestion, reviewLines } from "../render/market-review.ts";
import { answerOf, type MarketAsk } from "./request.ts";

/*
 * Install and update show the review before anything changes (ADR 0176 §11). On a terminal the
 * person confirms; without one, `--yes` installs with the review's defaults (no routines
 * started) after printing the review to stderr, and without `--yes` it exits 2 with the review in
 * the error. A blocked review exits 4. The install sends the reviewed hash, so bytes that changed
 * after the review aren't installed. In an agent's shell the install goes to the daemon, which
 * makes it the person's request in the thread.
 */

/** How the review is answered: by a person at a terminal, by `--yes`, or by the daemon's gate. */
export type Consent =
  | {
      readonly kind: "terminal";
      confirm(review: MarketReview, items: readonly MarketReviewItem[]): Promise<Choices>;
    }
  | { readonly kind: "yes" }
  | { readonly kind: "agent" }
  | { readonly kind: "none" };

export interface Choices {
  readonly startRoutines: boolean;
}

/** Bounded: a review's pages hold its files, texts, executions and changes. */
const maxPages = 20;

export async function reviewItems(
  ask: MarketAsk,
  review: MarketReview,
): Promise<MarketReviewItem[]> {
  const items: MarketReviewItem[] = [];
  let offset: number | undefined = 0;
  for (let page = 0; offset !== undefined && page < maxPages; page++) {
    const answer: { items: MarketReviewItem[]; nextOffset?: number | undefined } = answerOf(
      await ask({ op: "readReview", id: review.id, offset }),
      "reviewPage",
    );
    items.push(...answer.items);
    offset = answer.nextOffset;
  }
  return items;
}

export interface Installed {
  readonly review: MarketReview;
  readonly installed?: MarketInstalled | undefined;
}

/** What a terminal prints, or stderr carries, before the question. */
export function reviewText(review: MarketReview, items: readonly MarketReviewItem[]): string {
  return `${reviewLines(review, items).join("\n")}\n`;
}

/**
 * Runs one review to its end: refuses a blocked one, asks or takes `--yes`, then installs the
 * reviewed hash. `prepare` is `prepare` for an install and `prepareUpdate` for an update.
 */
export async function installReviewed(
  ask: MarketAsk,
  prepare: MarketOperation,
  consent: Consent,
  write: (text: string) => void,
): Promise<Installed> {
  const { review } = answerOf(await ask(prepare), "review");
  const items = await reviewItems(ask, review);
  const text = reviewText(review, items);
  if (review.blocked)
    throw new CliFailure("refused", review.blocked, { review }, { code: "refused" });
  let choices: Choices = { startRoutines: false };
  switch (consent.kind) {
    case "terminal":
      choices = await consent.confirm(review, items);
      break;
    case "yes":
    case "agent":
      write(text);
      break;
    case "none":
      // Nothing waits on the daemon for an answer that won't come.
      await ask({ op: "cancel", id: review.id }).catch(() => undefined);
      throw new CliFailure(
        "needs-human",
        `${installQuestion(review, items)} It needs your yes.`,
        { review, text },
        {
          code: "confirm",
          hint: "Read the review, then run the same command with --yes.",
        },
      );
  }
  const done = answerOf(
    await ask({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: { bots: [], needs: {}, startRoutines: choices.startRoutines },
    }),
    "done",
  );
  return { review, installed: done.installed };
}
