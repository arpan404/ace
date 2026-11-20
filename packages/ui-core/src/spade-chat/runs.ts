import { formatClock } from "../time.ts";
import type { SpadeChatItem } from "./skills.ts";

/*
 * A chat laid out as people read a messenger: the bot's bubbles in runs, another bot's in its
 * own runs under its name, everything else (the person's messages, helper lines) on its own row,
 * and a time line only where time passed: before the first thing said, after a 30-minute gap,
 * and on a new day. A routine's run names itself in its time line ("Morning check · Today 9:00
 * AM") rather than taking a row of its own. Every bubble keeps its exact time for hover. Pure:
 * the caller passes the clock, and the locale and time zone when it wants other than the host's.
 */

export type SpadeChatRow =
  | {
      kind: "time";
      key: string;
      /** "Today 9:00 AM", "Yesterday 11:31 PM", "Fri 3:11 AM", "Nov 3 6:00 PM". */
      label: string;
      /** The routine whose run this line starts, by name; undefined for a plain time line. */
      routine: string | undefined;
    }
  | {
      kind: "run";
      key: string;
      /** Whose bubbles: the bot's own, or another bot's that wrote here. */
      sender: { kind: "bot" } | { kind: "other"; agent: { id: string; name: string } };
      items: SpadeChatItem[];
      /** Each item's exact time, as the time line words it, by index; undefined when unknown. */
      whens: (string | undefined)[];
    }
  | {
      kind: "item";
      key: string;
      item: SpadeChatItem;
      /** When it was said, as the time line words it, for hover; undefined when unknown. */
      when: string | undefined;
    };

export interface SpadeChatClock {
  now: number;
  locale?: string;
  timeZone?: string;
}

/** A pause this long between two things said starts a new time line. */
export const spadeTimeGapMs = 30 * 60_000;

const botSide = new Set<SpadeChatItem["kind"]>([
  "bot",
  "ask",
  "question",
  "skill",
  "files",
  "digest",
  "steps",
  "recalled",
  "card",
  "notice",
]);

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
  const rows: SpadeChatRow[] = [];
  // Times only move forward: a bubble stamped earlier than what came before it (a reply that
  // began before the message that steered it) reads at the latest time seen.
  let latest: number | undefined;
  let run: Extract<SpadeChatRow, { kind: "run" }> | undefined;
  let runSender: string | undefined;
  for (const item of items) {
    const stamped = atOf(item);
    const at = stamped === undefined ? undefined : Math.max(stamped, latest ?? stamped);
    const when = at === undefined ? undefined : days.stamp(at);
    if (item.kind === "routine") {
      // The routine's run names itself in its line, whatever the gap.
      rows.push({
        kind: "time",
        key: `time:${item.key}`,
        label: when ?? item.label,
        routine: item.name,
      });
      if (at !== undefined) latest = at;
      run = undefined;
      continue;
    }
    if (at !== undefined) {
      const fresh =
        latest === undefined || at - latest >= spadeTimeGapMs || days.key(at) !== days.key(latest);
      latest = at;
      if (fresh && when !== undefined) {
        rows.push({ kind: "time", key: `time:${item.key}`, label: when, routine: undefined });
        run = undefined;
      }
    }
    const sender = senderOf(item);
    if (sender === undefined) {
      run = undefined;
      rows.push({ kind: "item", key: item.key, item, when });
      continue;
    }
    if (run && runSender === sender) {
      run.items.push(item);
      run.whens.push(when);
      continue;
    }
    run = {
      kind: "run",
      key: `run:${item.key}`,
      sender: item.kind === "other" ? { kind: "other", agent: item.agent } : { kind: "bot" },
      items: [item],
      whens: [when],
    };
    runSender = sender;
    rows.push(run);
  }
  return rows;
}

const dayMs = 86_400_000;
/** "2026-11-15" as a whole day count, so two days' distance is a subtraction. */
const dayNumber = (dayKey: string) => Date.parse(`${dayKey}T00:00:00Z`) / dayMs;

/** Each instant's calendar day in the reader's zone, and its words: "Today 9:00 AM". */
function dayReader(clock: SpadeChatClock) {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: clock.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekday = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    weekday: "short",
  });
  const thisYear = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    month: "short",
    day: "numeric",
  });
  const otherYear = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const key = (at: number) => keyFormat.format(at);
  const todayKey = key(clock.now);
  const today = dayNumber(todayKey);
  const day = (at: number) => {
    const dayKey = key(at);
    const ago = today - dayNumber(dayKey);
    if (ago === 0) return "Today";
    if (ago === 1) return "Yesterday";
    if (ago > 1 && ago < 7) return weekday.format(at);
    return dayKey.slice(0, 4) === todayKey.slice(0, 4) ? thisYear.format(at) : otherYear.format(at);
  };
  return {
    key,
    day,
    stamp: (at: number) => `${day(at)} ${formatClock(at, clock.locale, clock.timeZone)}`,
  };
}

/**
 * A past moment in the chat's words, short: "1:12 PM" today, else with its day as a time line
 * has it ("Yesterday 11:31 PM", "Fri 3:11 AM", "Nov 3 6:00 PM"). Never 24-hour by default.
 */
export function spadePastTime(at: number, clock: SpadeChatClock): string {
  const days = dayReader(clock);
  const time = formatClock(at, clock.locale, clock.timeZone);
  return days.key(at) === days.key(clock.now) ? time : `${days.day(at)} ${time}`;
}
