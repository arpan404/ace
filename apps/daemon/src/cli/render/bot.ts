import type { CliBotAction, CliBotDev, CliRunningBot } from "@ace/protocol/cli-outputs";

/** Words for `ace bot running|stop|pause|resume` (ADR 0200 §6.3) and `ace bot dev` (§9). Pure. */

const amber = (text: string, color: boolean) => (color ? `\u001b[33m${text}\u001b[39m` : text);
const red = (text: string, color: boolean) => (color ? `\u001b[31m${text}\u001b[39m` : text);
const dim = (text: string, color: boolean) => (color ? `\u001b[2m${text}\u001b[22m` : text);

const dollars = (micros: number) =>
  micros > 0 && micros < 10_000 ? "<$0.01" : `$${(micros / 1_000_000).toFixed(2)}`;

function bytes(count: number): string {
  if (count < 1000) return `${count} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = count / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A wake's time in `zone`: "08:20" within a day, else with its date. */
function clock(at: number, now: number, zone: string | undefined): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(at);
  if (at - now < 86_400_000) return time;
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: zone,
  }).format(at);
  return `${day} ${time}`;
}

function doing(bot: CliRunningBot, color: boolean): string {
  if (bot.reads === "needs_you") return amber(bot.doing, color);
  if (bot.reads === "failed") return red(bot.doing, color);
  return bot.doing;
}

/** What a row holds, spends and reaches, after its state. */
function facts(bot: CliRunningBot, now: number, zone: string | undefined): string {
  const [host] = bot.network.hosts;
  const reached = bot.network.hosts.length > 1 ? `${bot.network.hosts.length} hosts` : host;
  const network = reached ? `${bytes(bot.network.bytes)} with ${reached}` : "no network";
  const wake = bot.nextWake;
  const next = wake
    ? `${bot.reads === "paused" ? "held" : "next"} ${wake.what ? `${wake.what} ` : ""}${clock(wake.at, now, zone)}`
    : undefined;
  const spend = `${dollars(bot.spend.todayMicros)} today${bot.spend.unusual ? ", spending fast" : ""}`;
  return [bot.uses || undefined, spend, network, next].filter(Boolean).join(" · ");
}

/** Each bot on two lines (its state in words, then its facts) and its workers under it. */
export function runningLines(
  bots: readonly CliRunningBot[],
  now: number,
  color = false,
  zone?: string,
): string[] {
  if (!bots.length) return ["No bots yet. Make one in the app's Spade."];
  const width = Math.min(24, Math.max(...bots.map((bot) => bot.name.length)));
  const pad = " ".repeat(width);
  return bots.flatMap((bot) => [
    `${bot.name.padEnd(width)}  ${doing(bot, color)}`,
    `${pad}  ${dim(facts(bot, now, zone), color)}`,
    ...bot.workers.map((worker) => `${pad}  └ ${worker.name}: ${worker.doing}`),
  ]);
}

export function botActionWords(result: CliBotAction): string {
  const { name } = result;
  if (result.action === "stop")
    return result.changed ? `Stopped ${name} and its workers.` : `${name} had nothing running.`;
  if (result.action === "pause")
    return result.changed
      ? `Paused ${name}. Nothing of it fires until you resume it: ace bot resume ${result.bot}.`
      : `${name} was paused already.`;
  if (result.action === "unarchive")
    return result.changed
      ? `Unarchived ${name}. The routines that were on are on again; the rest stay paused.`
      : `${name} wasn't archived.`;
  return result.changed
    ? `Resumed ${name}. What came due while it was paused runs once now.`
    : `${name} wasn't paused.`;
}

/** One step in words; `watching` adds how to stop. Pure. */
export function devLine(step: CliBotDev, watching: boolean): string {
  const why = step.why?.length ? `\n  ${step.why.join("\n  ")}` : "";
  const more = watching ? " Watching for saves; Ctrl-C to stop." : "";
  switch (step.step) {
    case "installed":
      return `Installed ${step.name} as a development bot (${step.hash.slice(0, 7)}).${more}`;
    case "updated":
      return `Updated ${step.name} (${step.hash.slice(0, 7)}).`;
    case "unchanged":
      return `${step.name} is up to date (${step.hash.slice(0, 7)}).${more}`;
    case "waiting":
      return `${step.name} is working; the update waits for its next quiet moment.${why}`;
    case "refused":
      return `Not applied:${why}`;
  }
}
