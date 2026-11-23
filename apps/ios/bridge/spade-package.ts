import type { ClientCore } from "@ace/client";
import { PackagePlan, type MarketInstalled } from "@ace/protocol/marketplace";
import { offeredUpdate } from "@ace/ui-core/market";
import {
  decidedEachTime,
  effectLimits,
  effectWords,
  parseSpadePackage,
  spadeIsDevelopment,
  spadePackageSentence,
  SpadeRequestError,
  updateSentences,
  type SpadePackage,
  type SpadePackageEffect,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { segment } from "./spade-text.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";

/*
 * A bot linked to an agent package on its profile (ADR 0200 §3.4, §3.8, §3.9): the sentence
 * above its task saying which package and version it came from, Update when the Marketplace has
 * a newer one, Roll back to the version before, and that its version was withdrawn. Update and
 * Roll back open the Marketplace's own review on the phone (`MarketReviewSheet`), which shows
 * what changes, what stays and what it asks for before anything is applied. A bot made from one
 * of ace's templates updates from Spade, through its own review here. Its declared effects are
 * switches in its Security section: on is the person's grant, off narrows it.
 */

const agentId = z.string().min(1).max(256);
const Identity = z.object({
  source: z.string().max(64),
  name: z.string().max(128),
  version: z.string().max(64),
  hash: z.string().max(128),
});
const Offer = z.object({
  package: Identity,
  plan: PackagePlan,
  // No `catch`: an offer whose effects don't read is refused, never shown as asking for nothing.
  effects: z.array(z.unknown()).max(64),
});

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A declared effect as its switch: plain words, the reason, and whether it still asks each time. */
export interface SpadeEffectRow {
  key: string;
  words: string;
  why: string;
  on: boolean;
  /** A send, a payment or an access change still goes to the person every time, on or off. */
  eachTime: boolean;
  /** What it is held to beyond its words: a tool's argument patterns ("env matching staging"). */
  limits: string[];
}

const effectRow = (row: SpadePackageEffect): SpadeEffectRow => ({
  key: row.key,
  words: effectWords(row),
  why: row.why,
  on: row.on,
  eachTime: decidedEachTime(row),
  limits: effectLimits(row),
});

export interface SpadePackageRow {
  /** "From flight-watcher 1.0.0 in the Marketplace." */
  sentence: string;
  name: string;
  /** The Marketplace's newer version, while the bot can take it. */
  update: string | null;
  /** The version a rollback returns to. */
  rollBack: string | null;
  withdrawn: boolean;
  /** A template bot's newer template from this Spade, while the bot can take it. */
  template: string | null;
  /** The version the switches are read on; a switch is sent with it, so it can't land on another. */
  hash: string | null;
  effects: SpadeEffectRow[];
  /** Spade sent effects this build can't read: the list isn't all the package declares. */
  effectsIncomplete: boolean;
}

/**
 * The package line's words and what it offers: Update and Roll back only for a bot that is
 * still (not updating, no update held), never for a development bot, and Update not while its
 * version is withdrawn.
 */
export function packageRow(
  link: SpadePackage,
  bot: string,
  installed: readonly MarketInstalled[] | undefined,
  agent: string,
): SpadePackageRow {
  const still = !link.updating && !link.held;
  const market = link.source !== "spade" && !spadeIsDevelopment(link);
  const item = installed?.find(
    (each) => each.type === "spade-bot" && each.target === agent && each.linked,
  );
  const update = item ? offeredUpdate(item) : undefined;
  return {
    sentence: spadePackageSentence(link, bot),
    name: link.name,
    update: market && still && !link.withdrawn ? (update ?? null) : null,
    rollBack: market && still ? (link.previous ?? null) : null,
    withdrawn: link.withdrawn !== undefined,
    template:
      link.source === "spade" && still && !link.withdrawn ? (link.templateUpdate ?? null) : null,
    hash: link.hash ?? null,
    effects: link.effects.map(effectRow),
    effectsIncomplete: link.effectsDropped > 0,
  };
}

/** What the machine has installed from the Marketplace; undefined when it can't be read. */
async function readInstalled(owner: ClientCore, signal: AbortSignal) {
  try {
    const { result } = await owner.request(
      { type: "marketplace.request", operation: { op: "installed" } },
      { timeoutMs: 30_000, signal },
    );
    return result.op === "installed" ? result.installed : undefined;
  } catch {
    return undefined;
  }
}

type Answer =
  | SpadeOutcome
  | { ok: true; package: SpadePackageRow | null }
  | {
      ok: true;
      offer: {
        name: string;
        version: string;
        changes: string[];
        kept: string[];
        more: string[];
        effects: { words: string; why: string; limits: string[] }[];
        identity: z.infer<typeof Identity>;
      };
    };

export const spadePackageRequests = spadeRequestArea(
  [
    /** The bot's package line, or null for a bot that isn't linked to one. */
    z.object({ type: z.literal("spade.package"), agentId }),
    /** One declared effect's switch. */
    z.object({
      type: z.literal("spade.package.effect"),
      agentId,
      key: z.string().min(1).max(2100),
      on: z.boolean(),
      /** The package version the person read the switch on: Spade refuses it on any other. */
      hash: z.string().min(1).max(128),
    }),
    /** The template update's review: what changes, what stays, what it asks for. */
    z.object({ type: z.literal("spade.template"), agentId }),
    /** Take the very template version the review showed. */
    z.object({ type: z.literal("spade.template.take"), agentId, package: Identity }),
  ],
  async ({ ask, owner, spade, deps, signal }, request): Promise<Answer> => {
    const path = `/v1/agents/${segment(request.agentId)}/package`;
    switch (request.type) {
      case "spade.package":
        try {
          const bot = spade.bot(request.agentId);
          const [body, installed] = await Promise.all([
            ask("GET", path).catch((error: unknown) => {
              // A bot that isn't linked to a package has none: no line.
              if (error instanceof SpadeRequestError && error.status === 404) return "";
              throw error;
            }),
            readInstalled(owner, signal),
          ]);
          const raw = jsonOf(body);
          const link = parseSpadePackage(
            raw && typeof raw === "object" && "package" in raw ? raw.package : undefined,
          );
          return {
            ok: true,
            package: link
              ? packageRow(link, bot?.name || "this bot", installed, request.agentId)
              : null,
          };
        } catch (error) {
          return spadeRefused("Couldn't read its package", error);
        }
      case "spade.package.effect":
        try {
          await ask("PUT", `${path}/effects`, {
            key: request.key,
            on: request.on,
            hash: request.hash,
          });
          spade.refresh();
          return { ok: true };
        } catch (error) {
          return spadeRefused(request.on ? "Couldn't turn it on" : "Couldn't turn it off", error);
        }
      case "spade.template":
        try {
          const read = Offer.safeParse(jsonOf(await ask("GET", `${path}/template`)));
          if (!read.success) throw new Error("Spade's update didn't make sense.");
          const offer = read.data;
          const offered = parseSpadePackage({ ...offer.package, effects: offer.effects });
          // What it asks for must be read whole before the person can take it.
          if (!offered || offered.effectsDropped > 0)
            throw new Error(
              "Spade's update asks for things this ace can't show, so it can't be taken here. Update it on the computer.",
            );
          // The version in use, so an effect it now asks for otherwise is named as a change.
          const current = parseSpadePackage(
            (jsonOf(await ask("GET", path)) as { package?: unknown } | undefined)?.package,
          );
          const effects = offered.effects;
          const words = updateSentences(
            { plan: offer.plan, asksMore: [] },
            effects,
            current?.effects ?? [],
          );
          return {
            ok: true,
            offer: {
              name: offer.package.name,
              version: offer.package.version,
              ...words,
              effects: effects.map((row) => ({
                words: effectWords(row),
                why: row.why,
                limits: effectLimits(row),
              })),
              identity: offer.package,
            },
          };
        } catch (error) {
          return spadeRefused("Couldn't read the update", error);
        }
      case "spade.template.take":
        try {
          await ask("POST", path, {
            package: request.package,
            transaction: `template-${deps.id()}`,
          });
          spade.refresh();
          return { ok: true };
        } catch (error) {
          return spadeRefused("Couldn't update it", error);
        }
    }
  },
);
