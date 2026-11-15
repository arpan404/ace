import { formatClock } from "../time.ts";
import type { SpadeChatItem } from "./skills.ts";

/*
 * A chat laid out as people read one: the bot's bubbles in runs, with its face once at a run's
 * first bubble and the run's time under it; another bot's likewise under its name; everything
 * else (the person's messages, routine labels, helper lines) on its own row; and a day line
 * before the first thing said on each day. Pure: the caller passes the clock, and the locale and
 * time zone when it wants other than the host's.
 */

export type SpadeChatRow =
  | { kind: "day"; key: string; label: string }
  | {
      kind: "run";
      key: string;
      /** Whose bubbles: the bot's own, or another bot's that wrote here. */
      sender: { kind: "bot" } | { kind: "other"; agent: { id: string; name: string } };
      items: SpadeChatItem[];
      /** When the run began, as "6:12 PM"; undefined when none of it has a time yet. */
      time: string | undefined;
    }
  | {
      kind: "item";
      key: string;
      item: SpadeChatItem;
      /** When it was said, as "6:12 PM", for a tooltip; undefined when unknown. */
      time: string | undefined;
    };

export interface SpadeChatClock {
  now: number;
  locale?: string;
  timeZone?: string;
}

const botSide = new Set<SpadeChatItem["kind"]>(["bot", "ask", "question", "skill", "files"]);

/** Whose run an item belongs to, if any: "bot", another bot's id, or undefined for its own row. */
function senderOf(item: SpadeChatItem): string | undefined {
  if (botSide.has(item.kind)) return "bot";
  if (item.kind === "other") return `other:${item.agent.id}`;
  return undefined;
}

const atOf = (item: SpadeChatItem): number | undefined =>
  "at" in item && typeof item.at === "number" && item.at > 0 ? item.at : undefined;

export function spadeChatRows(
  items: readonly SpadeChatItem[],
  clock: SpadeChatClock,
): SpadeChatRow[] {
  const days = dayReader(clock);
  const time = (at: number | undefined) =>
    at === undefined ? undefined : formatClock(at, clock.locale, clock.timeZone);
  const rows: SpadeChatRow[] = [];
  // Times only move forward: a bubble stamped earlier than what came before it (a reply that
  // began before the message that steered it) reads at the latest time seen.
  let latest: number | undefined;
  let day: string | undefined;
  let run: Extract<SpadeChatRow, { kind: "run" }> | undefined;
  let runSender: string | undefined;
  for (const item of items) {
    const stamped = atOf(item);
    const at = stamped === undefined ? undefined : Math.max(stamped, latest ?? stamped);
    if (at !== undefined) {
      latest = at;
      const today = days.key(at);
      if (today !== day) {
        day = today;
        rows.push({ kind: "day", key: `day:${today}`, label: days.label(at) });
        run = undefined;
      }
    }
    const sender = senderOf(item);
    if (sender === undefined) {
      run = undefined;
      rows.push({ kind: "item", key: item.key, item, time: time(at) });
      continue;
    }
    if (run && runSender === sender) {
      run.items.push(item);
      run.time ??= time(at);
      continue;
    }
    run = {
      kind: "run",
      key: `run:${item.key}`,
      sender: item.kind === "other" ? { kind: "other", agent: item.agent } : { kind: "bot" },
      items: [item],
      time: time(at),
    };
    runSender = sender;
    rows.push(run);
  }
  return rows;
}

const dayMs = 86_400_000;

/** Each instant's calendar day in the reader's zone, and its words: Today, Yesterday, Monday. */
function dayReader(clock: SpadeChatClock) {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: clock.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekday = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    weekday: "long",
  });
  const thisYear = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const otherYear = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  // "2026-11-15", as a whole day count, so two days' distance is a subtraction.
  const key = (at: number) => keyFormat.format(at);
  const dayNumber = (dayKey: string) => Date.parse(`${dayKey}T00:00:00Z`) / dayMs;
  const today = dayNumber(key(clock.now));
  return {
    key,
    label(at: number) {
      const dayKey = key(at);
      const ago = today - dayNumber(dayKey);
      if (ago === 0) return "Today";
      if (ago === 1) return "Yesterday";
      if (ago > 1 && ago < 7) return weekday.format(at);
      return dayKey.slice(0, 4) === key(clock.now).slice(0, 4)
        ? thisYear.format(at)
        : otherYear.format(at);
    },
  };
}
