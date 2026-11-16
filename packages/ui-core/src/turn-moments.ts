import type { Item } from "@ace/protocol";
import { isSentByAgent } from "./sent-by.ts";
import { noticeInput, parseDelegationResults, systemInput } from "./system-events.ts";
import { formatClock } from "./time.ts";

/*
 * Moments: things that happened to a turn rather than in it, each said as one quiet row where it
 * happened. ace restarted and continued the turn; the turn waited out a usage limit; delegated
 * work came back. A restart writes two items (ace's notice, then the input it continues with) and
 * restarts in a row write two each: they read as one row. A restart or limit resume never starts
 * a turn of its own, so once the turn completes these rows fold into its "Worked for" with its
 * steps. Pure.
 */

export type MomentKind = "restart" | "limit" | "finished";

/** The notice ace writes when a restart cut the turn short and it carries on by itself. */
const continuingNotice = "Interrupted by a restart. Continuing.";

/** Which moment an item is part of, if any. */
export function momentOf(item: Item | undefined): MomentKind | undefined {
  if (!item) return undefined;
  if (item.type === "notice") {
    if (item.code === "restart_interrupted") return "restart";
    const legacy = noticeInput(item);
    if (legacy === "restart") return "restart";
    if (legacy === "limit_resume") return "limit";
    return undefined;
  }
  const input = systemInput(item);
  if (!input) return undefined;
  switch (input.kind) {
    // A resume after the provider's own process died says so in words of its own.
    case "restart":
      return input.origin?.afterExit ? undefined : "restart";
    case "limit_resume":
      return "limit";
    // Results ace can read are subagent rows (never folded); the rest is one quiet line.
    case "subagent_result":
      return isSentByAgent(input) || parseDelegationResults(input.text).length
        ? undefined
        : "finished";
    default:
      return undefined;
  }
}

export interface MomentLine {
  icon: "restart" | "resume" | "automation";
  text: string;
  /** When it happened, or the span it covered ("9:23–9:30 AM"). */
  from: number;
  to: number;
  /** What ace sent the agent, behind the row's disclosure. */
  received?: string | undefined;
}

const textOf = (item: Item) =>
  item.type === "notice"
    ? item.text
    : item.type === "message"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      : "";

const times = (count: number) => (count === 2 ? "twice" : count > 2 ? `${count} times` : undefined);

/**
 * How one moment row reads, from its items in order. `since` is when a wait began (the turn's
 * last activity before a usage limit paused it). Undefined for an empty moment.
 */
export function momentLine(
  kind: MomentKind,
  items: readonly Item[],
  since?: number,
): MomentLine | undefined {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return undefined;
  const inputs = items.filter((item) => item.type === "message");
  const received = inputs.map(textOf).join("\n\n") || undefined;
  switch (kind) {
    case "restart": {
      const notices = items.filter((item) => item.type === "notice");
      const stamps = notices.length ? notices : items;
      const count = notices.filter((item) => item.code === "restart_interrupted").length;
      const restarts = count || inputs.length || stamps.length;
      const continued = inputs.length > 0 || notices.some((item) => item.text === continuingNotice);
      const from = stamps[0]?.createdAt ?? first.createdAt;
      const to = stamps.at(-1)?.createdAt ?? last.createdAt;
      // Held for the person (a request expired, a loop): the notice says why, in its words.
      if (!continued) return { icon: "restart", text: textOf(last), from, to };
      const often = times(restarts);
      return {
        icon: "restart",
        text: often ? `Restarted ${often}, continued` : "Restarted, continued",
        from,
        to,
        received,
      };
    }
    case "limit":
      return {
        icon: "resume",
        text: "Waited for the usage limit",
        from: since !== undefined && since < last.createdAt ? since : first.createdAt,
        to: last.createdAt,
        received,
      };
    case "finished": {
      const threads = new Set(
        inputs.flatMap((item) => (item.type === "message" ? (item.origin?.threadIds ?? []) : [])),
      );
      const count = Math.max(threads.size, inputs.length);
      return {
        icon: "automation",
        text: count > 1 ? `${count} subagents finished` : "Delegated work finished",
        from: last.createdAt,
        to: last.createdAt,
        received,
      };
    }
  }
}

/**
 * "9:32 AM", or a span "9:23–9:30 AM" (one day period, said once). A span inside one minute
 * reads as that minute.
 */
export function formatMomentTime(from: number, to: number, locale?: string, zone?: string): string {
  const start = formatClock(from, locale, zone);
  const end = formatClock(to, locale, zone);
  if (start === end || to <= from) return end;
  const period = / ?[AP]M$/.exec(end)?.[0];
  const head = period && start.endsWith(period) ? start.slice(0, -period.length) : start;
  return `${head}–${end}`;
}

/** One stretch of an opened log: steps to group, or a moment row between them. */
export type MomentSegment<M> = { kind: "steps"; ids: string[] } | { kind: "moment"; moment: M };

/**
 * A turn's steps with its moments placed where they happened: each moment before the first step
 * created after it began. Steps keep their order; moments keep theirs. Pure.
 */
export function placeMoments<M extends { at: number }>(
  steps: readonly { id: string; at: number }[],
  moments: readonly M[],
): MomentSegment<M>[] {
  const segments: MomentSegment<M>[] = [];
  let open: string[] | undefined;
  let next = 0;
  const flush = (before: number) => {
    while (next < moments.length && (moments[next]?.at ?? Infinity) <= before) {
      const moment = moments[next++];
      if (!moment) break;
      open = undefined;
      segments.push({ kind: "moment", moment });
    }
  };
  for (const step of steps) {
    flush(step.at);
    if (!open) {
      open = [];
      segments.push({ kind: "steps", ids: open });
    }
    open.push(step.id);
  }
  flush(Infinity);
  return segments;
}
