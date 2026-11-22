import type { MarketNeed, MarketReview } from "@ace/protocol/marketplace";
import { parseSpadePersonality, spadePersonalityWords } from "../spade-chat/personality.ts";
import { allowedToolsSentence, unusedFieldsSentence } from "../spade-chat/skill-standard.ts";
import { andList, count, sentence } from "./words.ts";

/* What a review says an entry can do, and the switches a recipe's review starts with. */

/** What a skill's SKILL.md says beyond its name: licence, needs, allowed-tools, unused fields. */
function skillStandardLines(body: {
  license?: string | undefined;
  compatibility?: string | undefined;
  allowedTools?: string[] | undefined;
  unused?: string[] | undefined;
}): string[] {
  return [
    ...(body.license ? [`Licence: ${body.license}.`] : []),
    ...(body.compatibility ? [`It says it needs: ${sentence(body.compatibility)}`] : []),
    allowedToolsSentence(body.allowedTools ?? []),
    unusedFieldsSentence(body.unused ?? []),
  ].filter((line): line is string => line !== undefined);
}

/** The catalogue id of a connector need (`connector:<id>`); none for an address or a plugin. */
export function needCatalogue(key: string): string | undefined {
  const id = key.startsWith("connector:") ? key.slice("connector:".length) : undefined;
  return id && !id.includes(":") && !id.includes("/") ? id : undefined;
}

/** A recipe's need switches as its review opens them: required ones on, optional ones off. */
export function needDefaults(needs: readonly MarketNeed[]): Record<string, boolean> {
  return Object.fromEntries(needs.map((need) => [need.key, need.required]));
}

/** What Install does on this review: a first install, an update, or a linked bot going back. */
export function reviewAction(review: MarketReview): "Get" | "Update" | "Roll back" {
  const moving = review.body.type === "spade-bot" ? review.body.update : undefined;
  if (moving?.rollback) return "Roll back";
  return moving || review.updates ? "Update" : "Get";
}

/** The review's title: "Get Inbox", "Update Inbox", "Roll back Inbox". */
export const reviewHeading = (review: MarketReview): string =>
  `${reviewAction(review)} ${review.title}`;

/** "From store.acehq.dev, reviewed by ace." */
export function reviewFromLine(review: MarketReview): string {
  const from = review.from ? review.from.replace(/^https:\/\//, "") : "store.acehq.dev";
  return `From ${from}${review.reviewed || review.byAce ? ", reviewed by ace" : ""}.`;
}

/** What an update or a rollback does to the version in use; undefined for a first install. */
export function replacesLine(review: MarketReview): string | undefined {
  const moving = review.body.type === "spade-bot" ? review.body.update : undefined;
  if (moving?.rollback)
    return `Goes back to version ${review.version} from ${review.updates ?? "the one it has"}, from the copy kept on this machine.`;
  if (moving) return `Replaces version ${review.updates ?? ""}, which stays until you update.`;
  if (review.updates) return `Replaces version ${review.updates}, which stays until you install.`;
  return undefined;
}

/** Why Install waits while required apps are off: "Inbox can't work without Gmail and Slack." */
export function missingNeedsSentence(title: string, labels: readonly string[]): string | undefined {
  return labels.length ? `${title} can't work without ${labels.join(" and ")}.` : undefined;
}

/** What one review's body lets the entry do, as plain sentences. */
export function canDoSentences(review: MarketReview): string[] {
  const body = review.body;
  switch (body.type) {
    case "suit": {
      // A daemon from before families were tidied at the source sends repeats; each shows once.
      const fonts = [...new Set(body.fonts)];
      return [
        body.passes
          ? "Passes ace's checks."
          : `Fails ace's checks in ${count(body.problems.length, "place")}.`,
        body.scenes.length
          ? "Runs its own animation, sandboxed."
          : "Changes how ace looks, nothing else.",
        ...(fonts.length ? [`Sets its fonts: ${andList(fonts)}.`] : []),
        `${count(body.files, "file")}.`,
      ];
    }
    case "spade-skill":
      return [
        `Teaches Spade's bots “${body.skillName}”${body.description ? `: ${sentence(body.description)}` : "."}`,
        body.flagged
          ? `${count(body.files, "file")}, ${body.flagged} of them scripts or programs a bot can run under its gate.`
          : `${count(body.files, "file")}, none of them scripts.`,
        ...skillStandardLines(body),
      ];
    case "spade-plugin":
      return [
        body.executions
          ? `Runs ${count(body.executions, "command")} on this machine once accepted.`
          : "Runs no commands of its own.",
        ...(body.unsupported ? [`${count(body.unsupported, "part")} this ace can't use yet.`] : []),
        "Your coding agents get it too, unless you turn them off in its settings.",
      ];
    case "spade-bot":
      return [
        `Makes a new bot, ${body.botName}, on your ${body.model} model.`,
        // A package's event and webhook triggers are routines too (ADR 0200 §3.5).
        routinesLine(
          body.routines.length +
            (body.triggers ?? []).filter((t) => t.kind === "event" || t.kind === "webhook").length,
        ),
        ...(body.tools ? [`Uses only these tools: ${body.tools.join(", ")}.`] : []),
        ...personalityLine(body.personality),
      ];
  }
}

function routinesLine(routines: number): string {
  if (!routines) return "Has no routines.";
  return routines === 1
    ? "Has 1 routine, paused until you start it."
    : `Has ${routines} routines, paused until you start them.`;
}

/** How a recipe's bot talks, when it ships with a personality: "Talks: Concise, no jokes, no emoji." */
function personalityLine(raw: unknown): string[] {
  const personality = parseSpadePersonality(raw);
  return personality ? [`Talks: ${spadePersonalityWords(personality)}.`] : [];
}
