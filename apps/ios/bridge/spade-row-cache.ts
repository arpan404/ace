import { SpadeBubbleCache, type SpadeBubble, type SpadeView } from "@ace/ui-core/spade-chat";
import { spadeBubbleRow, type SpadeBubbleRow } from "./spade-rows.ts";
import type { SpadeWorkerFacts } from "./spade-worker-rows.ts";

/*
 * The open conversation's rows as it changes, each worked out once per bubble: the bubbles are
 * worked out again only from the entry that changed (`SpadeBubbleCache`), and a bubble that is
 * the same object as last time keeps its row and that row's JSON, so a reply's live words cost
 * one row per frame, not the history.
 */

/** A row as the phone is sent it, with its JSON for telling whether it changed. */
export interface SpadeMadeRow {
  key: string;
  row: SpadeBubbleRow;
  text: string;
}

export class SpadeRowCache {
  private readonly bubbles = new SpadeBubbleCache();
  private made = new WeakMap<SpadeBubble, SpadeMadeRow | null>();
  private who: string | undefined;

  rows(
    view: SpadeView,
    who: string,
    workers: SpadeWorkerFacts,
    approvers: string | null,
  ): SpadeMadeRow[] {
    // An approval's and a card's words name the bot.
    if (who !== this.who) {
      this.made = new WeakMap();
      this.who = who;
    }
    return this.bubbles.bubbles(view).flatMap((bubble): SpadeMadeRow[] => {
      // The workers' states come from live reads, and who may answer a request from the sharing.
      if (bubble.kind === "workers" || bubble.kind === "ask") {
        const row = spadeBubbleRow(bubble, who, workers);
        if (!row) return [];
        const shown = row.kind === "ask" ? { ...row, approvers } : row;
        return [{ key: bubble.key, row: shown, text: JSON.stringify(shown) }];
      }
      let made = this.made.get(bubble);
      if (made === undefined) {
        const row = spadeBubbleRow(bubble, who, workers);
        made = row ? { key: bubble.key, row, text: JSON.stringify(row) } : null;
        this.made.set(bubble, made);
      }
      return made ? [made] : [];
    });
  }
}
