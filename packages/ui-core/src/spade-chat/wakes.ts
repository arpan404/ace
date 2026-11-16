import { formatClock } from "../time.ts";
import type { SpadeKnownEvent } from "./wire.ts";

/*
 * A bot's open wakes (ADR 0160), folded from its conversation's events as Spade folds them
 * (`wake_set` without a later `wake_fired` or `wake_cancelled`), and the resting line that takes
 * the working line's place while it sleeps or waits. Pure: the clock and the names are passed in.
 */

export type SpadeWakePurpose = "sleep" | "wait" | "retry" | "outage" | "park";

export interface SpadeWake {
  wake: string;
  /** The reply that set it; empty for one Spade set after a reply closed. */
  reply: string;
  purpose: SpadeWakePurpose;
  /** A park's own reason (`check`, or a kind the chat doesn't word). */
  park: string | undefined;
  /** When it fires by time: a sleep's time, a wait's timeout, a retry's next try. */
  dueMs: number | undefined;
  /** What a wait waits for, as Spade stored it (`{kind, …}`). */
  condition: Readonly<Record<string, unknown>> | undefined;
  /** The bot's reason, in its words. */
  reason: string;
}

/** `wake_set`, as the chat keeps it. */
export function spadeWakeOf(event: Extract<SpadeKnownEvent, { type: "wake_set" }>): SpadeWake {
  const purpose = event.purpose.kind;
  return {
    wake: event.wake,
    reply: event.reply,
    purpose,
    park: purpose === "park" ? event.purpose.reason : undefined,
    dueMs: event.due_ms ?? undefined,
    condition: event.condition ?? undefined,
    reason: event.reason.trim(),
  };
}

/** The wake the person should see first, as Spade picks it: the soonest by time, else the oldest. */
export function spadeSoonestWake(wakes: Iterable<SpadeWake>): SpadeWake | undefined {
  let soonest: SpadeWake | undefined;
  let first: SpadeWake | undefined;
  for (const wake of wakes) {
    first ??= wake;
    if (wake.dueMs !== undefined && (soonest?.dueMs === undefined || wake.dueMs < soonest.dueMs))
      soonest = wake;
  }
  return soonest ?? first;
}

/** What the resting line offers: wake it now, try again now, or call the wake off. */
export type SpadeRestAction = "wake" | "try" | "cancel";

export interface SpadeRestLine {
  wake: string;
  /** "Sleeping until 2:05 PM", "Waiting for Linux repro to report". */
  words: string;
  /** Why, or until when at most: "staging settles", "until 2:20 PM at most". Empty when neither. */
  why: string;
  actions: readonly SpadeRestAction[];
}

/** The names a wait's words use, by the ids its condition holds. */
export interface SpadeRestNames {
  worker(id: string): string | undefined;
  service(id: string): string | undefined;
  bot(id: string): string | undefined;
}

export interface SpadeRestClock {
  now: number;
  locale?: string | undefined;
  timeZone?: string | undefined;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The resting line for `wake`. Every way a bot waits reads in the same line: a sleep or a wait
 * can be woken now or called off, an outage tried now (the person's message settles it, so it
 * has no Cancel), a parked task woken now. No cap or budget words: a park reads as a wait.
 */
export function spadeRestLine(
  wake: SpadeWake,
  names: SpadeRestNames,
  clock: SpadeRestClock,
): SpadeRestLine {
  const at = (ms: number) => spadeRestTime(ms, clock);
  const due = wake.dueMs;
  const line = (words: string, why: string, actions: readonly SpadeRestAction[]) => ({
    wake: wake.wake,
    words,
    why,
    actions,
  });
  switch (wake.purpose) {
    case "sleep":
      return line(due === undefined ? "Sleeping" : `Sleeping until ${at(due)}`, wake.reason, [
        "wake",
        "cancel",
      ]);
    case "wait":
      return line(
        waitWords(wake.condition, names),
        due === undefined ? wake.reason : `until ${at(due)} at most`,
        ["wake", "cancel"],
      );
    case "retry":
    case "outage":
      return line("Waiting out an outage", due === undefined ? "" : `trying again at ${at(due)}`, [
        "try",
      ]);
    case "park":
      return line(
        wake.park === "check" ? "Waiting to check the work again" : "Waiting",
        due === undefined ? "" : `until ${at(due)}`,
        ["wake"],
      );
  }
}

/** A wait's words, from its condition and the names this chat knows. */
function waitWords(
  condition: Readonly<Record<string, unknown>> | undefined,
  names: SpadeRestNames,
): string {
  const field = (key: string) => text(condition?.[key]);
  switch (condition?.kind) {
    case "job":
      return "Waiting for a job to finish";
    case "worker": {
      const name = field("worker") && names.worker(field("worker"));
      return name ? `Waiting for ${name} to report` : "Waiting for a worker to report";
    }
    case "thread": {
      const name = field("thread") && names.worker(field("thread"));
      return name ? `Waiting for ${name}` : "Waiting for an ace thread";
    }
    case "service_line": {
      const name = names.service(field("service")) ?? "a service";
      const pattern = field("pattern");
      return pattern ? `Waiting for ${name} to print “${pattern}”` : `Waiting for ${name}`;
    }
    case "service_exit":
      return `Waiting for ${names.service(field("service")) ?? "a service"} to exit`;
    case "file":
      return field("path") ? `Waiting for ${field("path")} to change` : "Waiting for a file";
    case "url":
      return field("url") ? `Waiting for ${field("url")} to answer` : "Waiting for a page";
    case "bot_message": {
      const bot = field("bot");
      const name = bot && (names.bot(bot) ?? bot);
      return name ? `Waiting for a message from ${name}` : "Waiting for another bot to write";
    }
    case "person":
      return "Waiting for your message";
    default:
      return "Waiting";
  }
}

const dayMs = 86_400_000;

/**
 * A wake's time as the person reads it: "2:05 PM" today, "Mon 2:05 PM" within the week ahead,
 * else "Nov 24, 2:05 PM". The person's locale and zone, never 24-hour by default.
 */
export function spadeRestTime(at: number, clock: SpadeRestClock): string {
  const clockWords = formatClock(at, clock.locale, clock.timeZone);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: clock.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const days =
    (Date.parse(`${day.format(at)}T00:00:00Z`) - Date.parse(`${day.format(clock.now)}T00:00:00Z`)) /
    dayMs;
  if (days === 0) return clockWords;
  const options: Intl.DateTimeFormatOptions =
    days > 0 && days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" };
  const date = new Intl.DateTimeFormat(clock.locale, { ...options, timeZone: clock.timeZone });
  return days > 0 && days < 7
    ? `${date.format(at)} ${clockWords}`
    : `${date.format(at)}, ${clockWords}`;
}
