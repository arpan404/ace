import type { MarketBotUpdate, MarketEffectRow, MarketReviewBody } from "@ace/protocol/marketplace";

/*
 * An agent package's review in plain sentences (ADR 0200 §3.4, §6.1), pure: each declared effect
 * as the row its switch sits on, what it expects to spend and use, what an update replaces, and
 * what stays because the person or the bot changed it.
 */

type Bot = Extract<MarketReviewBody, { type: "spade-bot" }>;

/** The person-only effects: declared, they can ask; they never run on a switch. */
const asksEachTime = new Set(["send_as_person", "pay", "change_access"]);

/** Whether a declared effect still goes to the person every time it is used. */
export const decidedEachTime = (row: Pick<MarketEffectRow, "effect">) =>
  asksEachTime.has(row.effect);

/** One declared effect as its switch's words: "Reaches api.example-fares.com". */
export function effectWords(row: Pick<MarketEffectRow, "effect" | "hosts" | "grant">): string {
  if (row.hosts?.length) return `Reaches ${row.hosts.join(", ")}`;
  switch (row.grant?.kind) {
    case "drive_site":
      return `Acts in pages on ${row.grant.host} as you`;
    case "drive_app":
      return `Acts in ${row.grant.app} as you`;
    case "tool":
      return `Uses ${row.grant.tool} without asking`;
    case undefined:
      break;
  }
  switch (row.effect) {
    case "network":
      return "Changes things outside its own folder, in your apps and online";
    case "publish":
      return "Publishes and posts";
    case "send_as_person":
      return "Can ask you to send things in your name";
    case "pay":
      return "Can ask you to pay";
    case "change_access":
      return "Can ask you to change sign-ins or access";
    default:
      return row.effect;
  }
}

/** Each declared effect's switch as the review starts it: on, for the person to turn off. */
export function effectDefaults(body: Bot): Record<string, boolean> {
  return Object.fromEntries((body.effects ?? []).map((row) => [row.key, true]));
}

const dollars = (usd: number) => `$${usd < 1 ? usd.toFixed(2) : usd.toFixed(usd % 1 ? 2 : 0)}`;

/** What it expects to spend and use: lines for the review's facts. Never a stop. */
export function limitSentences(body: Bot): string[] {
  const limits = body.limits;
  const lines: string[] = [];
  if (limits?.spend_alert)
    lines.push(
      `Expected to cost about ${dollars(limits.spend_alert.usd_per_day)} a day on your ${body.model} model.`,
    );
  if (limits?.workers_at_once)
    lines.push(
      limits.workers_at_once === 1
        ? "Runs one of its workers at a time."
        : `Runs at most ${limits.workers_at_once} of its workers at once.`,
    );
  if (limits?.workspace_mb)
    lines.push(`Expects its files to reach about ${limits.workspace_mb} MB.`);
  if (body.triggers?.some((trigger) => trigger.kind === "mention"))
    lines.push("Can be @-mentioned from your threads and clubs.");
  if (body.unused?.length) lines.push(`Not used by this Spade: ${body.unused.join(", ")}.`);
  return lines;
}

/** A routine-like trigger other than a schedule, as its row's second line. */
export function triggerWhen(trigger: NonNullable<Bot["triggers"]>[number]): string | undefined {
  switch (trigger.kind) {
    case "event":
      return trigger.event === "thread.finished"
        ? "When an agent thread finishes"
        : trigger.event === "thread.failed"
          ? "When an agent thread fails"
          : "When an agent thread needs you";
    case "webhook":
      return "When something on this machine posts to it";
    case "message":
    case "mention":
      return undefined;
  }
}

const fieldWords = {
  task: ["Its task changes to the new one.", "You changed its task, so this update leaves it."],
  name: ["Its name changes.", "You renamed it, so it keeps its name."],
  face: ["Its face changes.", "You changed its face, so it keeps it."],
  personality: ["How it talks changes.", "You changed how it talks, so that stays."],
} as const;

/** What an update or rollback changes, and what stays because the person or the bot changed it. */
export function updateSentences(
  update: MarketBotUpdate,
  effects: readonly MarketEffectRow[],
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
      return `${row ? effectWords(row) : key}. Off until you turn it on.`;
    }),
    ...update.asksMore,
  ];
  if (plan.off.length)
    changes.push(
      plan.off.length === 1
        ? "It no longer asks for one thing the version before did; that's turned off."
        : `It no longer asks for ${plan.off.length} things the version before did; those are turned off.`,
    );
  return { changes, kept, more };
}
