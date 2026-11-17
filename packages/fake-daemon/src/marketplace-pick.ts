import type {
  MarketPickType,
  MarketPublishable,
  MarketResult,
  Recipe,
} from "@ace/protocol/marketplace";

/*
 * The publish flow's picker as the fake daemon answers it (ADR 0174 §2): the seeded bots, skills
 * and plugins the person could publish, and each bot's recipe as Spade would export it. A
 * fixture gives a Spade bot with routines and needs, a Spade skill, an ace skill and a plugin.
 */

export interface MarketPickSeed {
  items?: MarketPublishable[];
  /** Each bot's recipe and what it left out, by Spade's bot id. */
  recipes?: Record<string, { recipe: Recipe; leftOut: string[] }>;
  /** Places that couldn't be read, by type: "Spade isn't running." */
  unavailable?: Partial<Record<MarketPickType, string[]>>;
}

export class FakeMarketPick {
  #seed: MarketPickSeed = {};

  seed(seed: MarketPickSeed): void {
    this.#seed = structuredClone(seed);
  }

  publishables(type: MarketPickType): MarketResult {
    return {
      op: "publishables",
      items: (this.#seed.items ?? []).filter((item) => item.type === type),
      unavailable: this.#seed.unavailable?.[type] ?? [],
    };
  }

  botRecipe(id: string): MarketResult {
    const found = this.#seed.recipes?.[id];
    if (!found) return { op: "error", code: "not_found", message: "no such agent" };
    return { op: "botRecipe", ...structuredClone(found) };
  }
}

const inboxFace = {
  kind: "character",
  v: 1,
  body: "round",
  pair: "lagoon",
  ears: "none",
  marking: "muzzle",
  eyes: "egg",
  mouth: "smile",
  cheeks: "blush",
  accessory: "glasses",
};

/** A person with a bot in Spade, a skill in Spade and one in ace's library, and a plugin. */
export function marketPickFixture(): MarketPickSeed {
  return {
    items: [
      {
        type: "spade-bot",
        name: "inbox-sorter",
        title: "Inbox sorter",
        line: "You look after the person's inbox.",
        from: "spade",
        face: inboxFace,
        source: { kind: "spade-bot", id: "a_inbox" },
      },
      {
        type: "spade-skill",
        name: "release-notes",
        title: "release-notes",
        line: "Writes release notes from merged work.",
        from: "spade",
        source: { kind: "spade-skill", id: "sks_0123456789abcdef0123" },
      },
      {
        type: "spade-skill",
        name: "triage-mail",
        title: "Triage mail",
        line: "Sorts mail into what needs a reply.",
        from: "ace",
        source: { kind: "ace-skill", id: `skl_${"a".repeat(40)}` },
      },
      {
        type: "spade-plugin",
        name: "mail-tools",
        title: "mail-tools",
        line: "Version 1.2.0",
        from: "plugin",
        source: { kind: "plugin", name: "mail-tools" },
      },
    ],
    recipes: {
      a_inbox: {
        recipe: {
          format: "spade-bot",
          version: 2,
          name: "Inbox sorter",
          blurb: "",
          task: "You look after the person's inbox.",
          face: inboxFace,
          model: "fast",
          routines: [
            {
              name: "Morning sort",
              instruction: "Sort the inbox.",
              schedule: "weekdays at 8:00",
            },
          ],
          skills: ["spade-skill/triage-mail"],
          plugins: ["spade-plugin/mail-tools"],
          needs: {
            connectors: [{ id: "gmail", why: "Gmail is allowed for this bot.", required: true }],
          },
          notes: [],
        },
        leftOut: ["The routine \"Hook\" doesn't run on a schedule, so a recipe can't carry it."],
      },
    },
  };
}
