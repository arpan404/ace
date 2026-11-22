import type {
  MarketInstallChoices,
  MarketOperation,
  MarketResult,
  MarketReview,
} from "@ace/protocol/marketplace";
import { defaultChoices } from "./market-review.ts";

/*
 * The reviews this phone holds open on the machine, from `prepare` until Install, Cancel or
 * expiry (spec items 9 to 13). The bridge, not the sheet, keeps Install honest: it is sent only
 * once every page of the review was read, only with that review's own hash, and only with the
 * choices the review offered, each need and effect named explicitly as the person left it.
 */

type Install = Extract<MarketOperation, { op: "install" }>;

interface Held {
  readonly review: MarketReview;
  /** The next offset a page must start at or before to count as read in order. */
  read: number;
  /** A page with nothing after it was read, with every page before it. */
  complete: boolean;
}

/** Why the bridge didn't send an install, as the phone's refusal: code, sentence, way out. */
export interface HeldRefusal {
  code: string;
  message?: string;
}

export class HeldReviews {
  readonly #held = new Map<string, Held>();

  /**
   * The install to send, its choices made whole from the review; or why it can't be sent. An
   * id the bridge doesn't hold (it restarted, or the review was dropped) is expired.
   */
  install(operation: Install): { send: Install } | { refuse: HeldRefusal } {
    const held = this.#held.get(operation.id);
    if (!held) return { refuse: { code: "expired" } };
    if (operation.hash !== held.review.hash) return { refuse: { code: "conflict" } };
    if (held.review.blocked) return { refuse: { code: "blocked", message: held.review.blocked } };
    if (!held.complete)
      return {
        refuse: { code: "unread", message: "Read the whole review before you install it." },
      };
    return { send: { ...operation, choices: wholeChoices(held.review, operation.choices) } };
  }

  /** What the machine answered, so the held reviews follow it. */
  heard(operation: MarketOperation, result: MarketResult): void {
    if (result.op === "review") {
      this.#held.set(result.review.id, { review: result.review, read: 0, complete: false });
      return;
    }
    if (result.op === "reviewPage" && operation.op === "readReview") {
      const held = this.#held.get(result.review.id);
      if (!held || operation.offset > held.read) return;
      held.read = Math.max(held.read, operation.offset + result.items.length);
      if (result.nextOffset === undefined) held.complete = true;
      return;
    }
    if (result.op === "done" && (operation.op === "install" || operation.op === "cancel"))
      this.#held.delete(operation.id);
    if (
      result.op === "error" &&
      (result.code === "expired" || result.code === "conflict") &&
      (operation.op === "install" || operation.op === "readReview")
    )
      this.#held.delete(operation.id);
  }
}

/** Each declared switch as the person left it, else as the review started it. */
const pick = (defaults: Record<string, boolean>, chosen: Record<string, boolean> | undefined) =>
  Object.fromEntries(
    Object.entries(defaults).map(([key, on]) => [key, chosen?.[key] ?? on] as const),
  );

/**
 * The choices sent with Install: each need and effect the review declares, as the person left it
 * or as the review started it, and nothing it didn't declare. Bots only for a plugin.
 */
function wholeChoices(review: MarketReview, sent: MarketInstallChoices): MarketInstallChoices {
  const start = defaultChoices(review);
  return {
    bots: review.type === "spade-plugin" ? [...new Set(sent.bots)] : [],
    needs: pick(start.needs, sent.needs),
    startRoutines: review.body.type === "spade-bot" && sent.startRoutines === true,
    ...("effects" in start && start.effects ? { effects: pick(start.effects, sent.effects) } : {}),
  };
}
