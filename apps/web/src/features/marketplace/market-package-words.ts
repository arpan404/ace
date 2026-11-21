import type { MarketReviewBody } from "@ace/protocol/marketplace";
import { effectStartsOn } from "@ace/ui-core/spade-chat";

export { decidedEachTime, effectWords } from "@ace/ui-core/spade-chat";

/*
 * An agent package's review in plain sentences (ADR 0200 §3.4, §6.1), pure: each declared effect
 * as the row its switch sits on and what it expects to spend and use. What an update replaces
 * and what stays is `updateSentences`, in `@ace/ui-core/spade-chat`, since Spade's own update
 * review says it too.
 */

type Bot = Extract<MarketReviewBody, { type: "spade-bot" }>;

/**
 * Each declared effect's switch as the review starts it (`effectStartsOn`): a package by ace
 * starts with what it declares; a stranger's starts with only its declared hosts.
 */
export function effectDefaults(body: Bot, byAce: boolean): Record<string, boolean> {
  return Object.fromEntries([
    ...(body.effects ?? []).map((row) => [row.key, effectStartsOn(row, byAce)]),
    // A component the review lists runs once installed unless the person turns it off here.
    ...(body.code ?? []).map((row) => [codeKey(row.name), true]),
  ]);
}

/** A component's switch, beside the effects' (ADR 0203 §5): `code:fares`. */
export function codeKey(name: string): string {
  return `code:${name}`;
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
