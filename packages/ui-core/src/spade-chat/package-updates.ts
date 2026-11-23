import type { MarketBotUpdate } from "@ace/protocol/marketplace";
import { effectKeyWords, effectLimits, effectWords, type SpadeDeclaredEffect } from "./packages.ts";

/*
 * What a package update or rollback changes in plain sentences (ADR 0200 §6.1), pure: what it
 * replaces, what stays because the person or the bot changed it, and what it asks for that starts
 * off. Every update review says it in these words: the marketplace's and a bot profile's.
 */

const fieldWords = {
  task: ["Its task changes to the new one.", "You changed its task, so this update leaves it."],
  name: ["Its name changes.", "You renamed it, so it keeps its name."],
  face: ["Its face changes.", "You changed its face, so it keeps it."],
  personality: ["How it talks changes.", "You changed how it talks, so that stays."],
} as const;

type KeyedEffect = SpadeDeclaredEffect & { key: string };

/** An effect's words with what it is held to: "Uses deploy without asking, env matching staging". */
const heldWords = (row: SpadeDeclaredEffect) => [effectWords(row), ...effectLimits(row)].join(", ");

/**
 * What an update or rollback changes, and what stays because the person or the bot changed it.
 * Every effect it adds, changes or takes away is named: one it asks for more starts off, one
 * the version before asked for that this one doesn't is turned off, and, given the effects of
 * the version in use (`before`), one under the same key that now reaches or allows otherwise.
 */
export function updateSentences(
  update: Pick<MarketBotUpdate, "plan" | "asksMore">,
  effects: readonly KeyedEffect[],
  before: readonly KeyedEffect[] = [],
): { changes: string[]; kept: string[]; more: string[] } {
  const { plan } = update;
  const changes: string[] = [];
  const kept: string[] = [];
  for (const field of ["task", "name", "face", "personality"] as const) {
    const [changed, stays] = fieldWords[field];
    if (plan[field] === "replace") changes.push(changed);
    if (plan[field] === "kept") kept.push(stays);
  }
  for (const routine of plan.routines)
    switch (routine.step) {
      case "add":
        changes.push(`Adds the routine ${routine.name}, paused until you start it.`);
        break;
      case "replace":
        changes.push(`Changes the routine ${routine.name}.`);
        break;
      case "remove":
        changes.push(`Removes the routine ${routine.name}.`);
        break;
      case "kept":
        kept.push(
          routine.removed
            ? `You removed the routine ${routine.name}, so it isn't put back.`
            : `You changed the routine ${routine.name}, so it stays as you left it.`,
        );
    }
  if (plan.notes_kept)
    kept.push(
      plan.notes_kept === 1
        ? "You changed one of its notes, so it stays."
        : `You changed ${plan.notes_kept} of its notes, so they stay.`,
    );
  const more = [
    ...plan.asks_more.map((key) => {
      const row = effects.find((each) => each.key === key);
      return `${row ? heldWords(row) : effectKeyWords(key)}. Off until you turn it on.`;
    }),
    ...update.asksMore,
  ];
  for (const key of plan.off) {
    const row = before.find((each) => each.key === key);
    changes.push(
      `No longer asks for this, so it's turned off: ${row ? heldWords(row) : effectKeyWords(key)}.`,
    );
  }
  for (const row of effects) {
    const was = before.find((each) => each.key === row.key);
    if (was && heldWords(was) !== heldWords(row))
      changes.push(`Changes what it asks for: ${heldWords(row)}. Before: ${heldWords(was)}.`);
  }
  return { changes, kept, more };
}
