import type { MarketInstalled, MarketResult } from "@ace/protocol/marketplace";
import { count } from "@ace/ui-core/market";
import { installedRow, updatesText } from "./market-rows.ts";

/*
 * What the machine has installed from the market, for the phone (spec items 16 to 19): updates
 * first, then everything else, each row with its words and the actions it offers already
 * decided, so Swift only draws. An update is never applied here: Update opens its review. A
 * withdrawn or turned-off entry stays off until the person turns it back on. Pure.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

/** An update the person accepted that waits for its bot's turn isn't offered again. */
const offered = (item: MarketInstalled): string | null =>
  item.update && item.update !== item.held?.version ? item.update : null;

export function installedAnswer(result: Result<"installed">) {
  const rows = result.installed
    .map(installedItem)
    .toSorted(
      (a, b) =>
        Number(b.update !== null) - Number(a.update !== null) || a.title.localeCompare(b.title),
    );
  const updates = rows.filter((row) => row.update !== null).length;
  return {
    rows,
    updates,
    updatesText: updatesText(updates),
    /** The updates section's title. */
    updatesTitle: updates ? count(updates, "update") : "No updates",
    upToDate: rows.length && !updates ? "Everything is up to date. ace checks once a day." : null,
    empty: rows.length ? null : "What you get from the marketplace shows here.",
  };
}

/** One installed entry as Installed's row. */
function installedItem(item: MarketInstalled) {
  const update = offered(item);
  const row = installedRow({ ...item, update: update ?? undefined });
  const bot = row.bot !== null;
  return {
    ...row,
    section: update ? ("updates" as const) : ("installed" as const),
    meta: `${row.typeWord} · ${item.version}${update ? ` → ${update}` : ""}`,
    off: item.state !== "on",
    /** Lines under the title; while off, the first says why. */
    notes: notes(item),
    updateLabel: update ? `Update ${item.title} to ${update}` : null,
    /** A bot package's update moves one bot, never its siblings (ADR 0200). */
    updateLine:
      update && bot
        ? `Only ${item.title} moves to ${update}. Your other bots from this package stay as they are.`
        : null,
    /** The version a linked bot can go back to, from the copy kept on the machine. */
    rollBackTo: item.linked && item.previous ? item.previous.version : null,
    /** A blocked entry is off until removed; a withdrawn or turned-off one can come back. */
    turnOnWord:
      item.state === "withdrawn" || item.state === "off"
        ? item.linked
          ? "Resume"
          : "Turn back on"
        : null,
    removeQuestion: bot ? `Remove ${item.title}'s skills and plugins?` : `Remove ${item.title}?`,
    removeDetail: removeDetail(item),
  };
}

function notes(item: MarketInstalled): string[] {
  const lines: string[] = [];
  const why = item.reason ? `: ${item.reason}` : ".";
  if (item.state === "withdrawn") lines.push(`Off · Withdrawn by its publisher${why}`);
  if (item.state === "blocked") lines.push(`Off · ace blocked it${why} Remove it.`);
  if (item.state === "off") lines.push("Off · You turned it off.");
  if (item.held) lines.push(`Update to ${item.held.version} waits for its turn.`);
  if (item.deprecated) lines.push(`Its publisher deprecated this version: ${item.deprecated}`);
  if (item.updatesStopped) lines.push(item.updatesStopped);
  return lines;
}

function removeDetail(item: MarketInstalled): string {
  switch (item.type) {
    case "spade-bot":
      return "The bot stays yours.";
    case "suit":
      return "The Suit comes off this machine.";
    case "spade-skill":
      return "Your bots and agents stop seeing this skill.";
    case "spade-plugin":
      return "Its commands and servers stop for every bot and agent.";
    default:
      return "It comes off this machine.";
  }
}
