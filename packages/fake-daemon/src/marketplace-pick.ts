import { privacySpans, withSentences } from "@ace/marketplace";
import type {
  MarketDraftCheck,
  MarketPickType,
  MarketPublishable,
  MarketPublishAction,
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
  /**
   * What `draftCheck` answers for a source, by its JSON; absent, one clean SKILL.md. A bot's
   * check is built from its recipe with the real privacy pass.
   */
  checks?: Record<string, Omit<MarketDraftCheck, "hash" | "bot">>;
  /** The person's own name and username, which the privacy pass flags. */
  names?: string[];
}

type DraftSource = Extract<MarketPublishAction, { action: "draftCreate" }>["source"];
/** Sources checked on the machine before a draft is made, as the daemon checks them. */
const checkedKinds = new Set(["folder", "spade-bot", "spade-skill", "ace-skill", "plugin"]);
const hashOf = (source: DraftSource) =>
  [...JSON.stringify(source).padEnd(64, "0")]
    .map((char) => (char.charCodeAt(0) % 16).toString(16))
    .join("")
    .slice(0, 64);

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

  /** The privacy pass, as the daemon runs it. */
  privacy(texts: readonly string[]): MarketResult {
    const names = this.#seed.names ?? [];
    return {
      op: "privacyCheck",
      spans: texts.map((text) => withSentences(privacySpans(text, { names }))),
    };
  }

  /** What a draft from `source` would upload. */
  check(source: DraftSource): MarketResult {
    const hash = hashOf(source);
    if (source.kind === "spade-bot") {
      const found = this.#seed.recipes?.[source.id];
      if (!found) return { op: "error", code: "not_found", message: "no such agent" };
      const names = this.#seed.names ?? [];
      const spans = (text: string) => withSentences(privacySpans(text, { names }));
      const { recipe } = found;
      const check: MarketDraftCheck = {
        files: [],
        excluded: [],
        findings: [],
        hash,
        bot: {
          recipe,
          leftOut: found.leftOut,
          name: spans(recipe.name),
          task: spans(recipe.task),
          routines: recipe.routines.map((routine) => ({
            name: spans(routine.name),
            instruction: spans(routine.instruction),
          })),
        },
      };
      return { op: "publish", answer: { kind: "checked", check } };
    }
    const seeded = this.#seed.checks?.[JSON.stringify(source)] ?? {
      files: [{ path: "SKILL.md", bytes: 120, binary: false }],
      excluded: [],
      findings: [],
    };
    return {
      op: "publish",
      answer: { kind: "checked", check: { ...structuredClone(seeded), hash } },
    };
  }

  /** Why a draft can't be made yet: its source wasn't checked, or its check changed. */
  refusal(action: MarketPublishAction): MarketResult | undefined {
    if (action.action !== "draftCreate" && action.action !== "draftUpdate") return undefined;
    if (!action.source || !checkedKinds.has(action.source.kind)) return undefined;
    if (!action.checked)
      return {
        op: "error",
        code: "refused",
        message: "Check what will upload and confirm it first",
      };
    if (action.checked.hash !== hashOf(action.source))
      return { op: "error", code: "refused", message: "It changed since you checked it" };
    return undefined;
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
    names: ["Arlo Quint", "arloq"],
    items: [
      {
        type: "spade-bot",
        name: "inbox-sorter",
        title: "Inbox sorter",
        line: "You look after Arlo Quint's inbox.",
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
          triggers: [],
          effects: [],
          tests: [],
          name: "Inbox sorter",
          blurb: "",
          task: "You look after Arlo Quint's inbox.",
          face: inboxFace,
          model: "fast",
          routines: [
            {
              name: "Morning sort",
              instruction: "Sort the inbox.",
              schedule: "weekdays at 8:00",
            },
            {
              name: "File receipts",
              instruction: "Save receipts to /Users/arloq/Receipts.",
              schedule: "daily at 18:00",
            },
          ],
          skills: ["spade-skill/triage-mail"],
          plugins: ["spade-plugin/mail-tools"],
          needs: {
            connectors: [{ id: "gmail", why: "The bot uses this app.", required: true }],
          },
          notes: [],
        },
        leftOut: [
          "The routine \"Hook\" doesn't run on a schedule, so a recipe can't carry it.",
          "It uses a custom app you added, which a recipe can't ask for.",
        ],
      },
    },
  };
}
