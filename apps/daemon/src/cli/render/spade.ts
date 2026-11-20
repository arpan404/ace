import type { CliSpadeBot } from "@ace/protocol/cli-outputs";
import type { FeatureSwitch } from "../features.ts";
import type { SpadeState, SpadeSwitch } from "../spade.ts";

/** Words for Spade, Beta switches and Spade's bots (ADR 0178 §3). Pure: value → lines. */

const onOff = (on: boolean) => (on ? "on" : "off");
const amber = (text: string, color: boolean) => (color ? `\u001b[33m${text}\u001b[39m` : text);
const red = (text: string, color: boolean) => (color ? `\u001b[31m${text}\u001b[39m` : text);

export function spadeSwitchWords(result: SpadeSwitch): string {
  const beta = result.beta ? "Spade is turned on in Settings › Beta. " : "";
  if (!result.enabled) return "Spade is off.";
  return result.live
    ? `${beta}Spade is on.`
    : `${beta}Spade is on. Its ace tools start working once the ace daemon runs.`;
}

export function spadeStateLines(state: SpadeState, color = false): string[] {
  if (!state.beta)
    return ["Spade is hidden: Settings › Beta has it off.", "Turn it on with ace spade on."];
  if (!state.enabled) return ["Spade is off.", "Turn it on with ace spade on."];
  if (!state.live) return ["Spade is on. It starts when the ace daemon runs (ace start)."];
  const status = state.status;
  if (!status) return ["Spade is on."];
  const version = status.version ? ` (Spade ${status.version})` : "";
  const lines: string[] = [];
  if (status.state === "ready")
    lines.push(
      status.setup
        ? `Spade is setting up: ${status.setup.reason}.`
        : `Spade is on and ready${version}.`,
    );
  else if (status.state === "starting") lines.push("Spade is starting.");
  else if (status.state === "failed")
    lines.push(red(`✕ Spade failed${status.reason ? `: ${status.reason}` : "."}`, color));
  else lines.push(`Spade is off${status.reason ? `: ${status.reason}` : "."}`);
  if (status.thread?.busy) lines.push(`Its host thread ${status.thread.id} is working.`);
  if (status.grant?.state === "revoked")
    lines.push("Its grant for ace's tools is revoked; turn Spade off and on to make a new one.");
  if (status.state === "failed") lines.push("See why with ace logs, or run ace doctor.");
  return lines;
}

export function featureLines(features: Readonly<Record<"spade" | "marketplace", boolean>>) {
  return [`Spade: ${onOff(features.spade)}`, `Marketplace: ${onOff(features.marketplace)}`];
}

/** The JSON the first CLI printed for `ace features on|off X`, unchanged. */
export function featureJson(result: FeatureSwitch) {
  return result.feature === "marketplace"
    ? { marketplace: result.on, live: result.live }
    : { spade: result.on, live: result.live, stopped: result.stopped };
}

export function featureWords(result: FeatureSwitch): string {
  if (result.feature === "marketplace")
    return result.on
      ? "The marketplace is turned on."
      : "The marketplace is turned off. What you installed from it keeps working.";
  if (result.on)
    return result.started
      ? result.live
        ? "Spade is turned on. The ace daemon is starting it."
        : "Spade is turned on. It starts when the ace daemon next runs."
      : "Spade is turned on. Start it in Settings or with ace spade on.";
  if (result.live)
    return "Spade is turned off. The ace daemon is stopping its service; its data is kept.";
  return result.stopped
    ? "Spade is turned off and its service was stopped. Its data is kept."
    : "Spade is turned off. Its data is kept.";
}

/** One glyph per state, in its colour only on a terminal; nothing for idle. */
function botGlyph(bot: CliSpadeBot, color: boolean): string {
  if (bot.state === "waiting") return amber(bot.waitingFor === "approval" ? "◆" : "?", color);
  if (bot.state === "working") return "◌";
  if (bot.problem) return red("✕", color);
  if (bot.unseen) return "✓";
  return " ";
}

export function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

const rank = (bot: CliSpadeBot) =>
  bot.pinned ? 0 : bot.state === "waiting" ? 1 : bot.state === "working" ? 2 : bot.unseen ? 3 : 4;

/** Spade's bots in the app's order: pinned, needs you, working, unseen, then the rest. */
export function botOrder(bots: readonly CliSpadeBot[]): CliSpadeBot[] {
  return bots.toSorted((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
}

export function botListLines(bots: readonly CliSpadeBot[], now: number, color = false): string[] {
  if (!bots.length) return ["No bots yet. Make one in the app's Spade."];
  const ordered = botOrder(bots);
  const width = Math.min(28, Math.max(...ordered.map((bot) => bot.name.length)));
  return ordered.map((bot) => {
    const doing =
      bot.state === "working"
        ? (bot.status ?? "working")
        : bot.state === "waiting"
          ? `needs you: ${bot.waitingFor ?? "an answer"}`
          : bot.state === "paused"
            ? "paused"
            : (bot.problem ?? age(bot.lastActivity, now));
    return `${botGlyph(bot, color)} ${bot.name.padEnd(width)}  ${bot.id}  ${doing}`;
  });
}

export function botLines(bot: CliSpadeBot, now: number, color = false): string[] {
  const lines = [
    `${botGlyph(bot, color).trim() ? `${botGlyph(bot, color)} ` : ""}${bot.name}  ${bot.id}`,
  ];
  if (bot.task) lines.push(bot.task);
  lines.push(`Model         ${bot.model}`);
  lines.push(`Conversation  ${bot.conversation}`);
  if (bot.parent) lines.push(`Made by       ${bot.parent.name} (${bot.parent.id})`);
  if (bot.state === "working") lines.push(`Working       ${bot.status ?? ""}`.trimEnd());
  if (bot.state === "waiting") lines.push(`Needs you     ${bot.waitingFor ?? "an answer"}`);
  if (bot.state === "paused")
    lines.push(`Paused        until you resume it: ace bot resume ${bot.id}`);
  if (bot.problem) lines.push(red(`✕ ${bot.problem}`, color));
  if (bot.lastMessage)
    lines.push(
      `Last          ${bot.lastMessage.from === "person" ? "you" : bot.name}, ${age(bot.lastMessage.at, now)} ago: ${oneLine(bot.lastMessage.text)}`,
    );
  lines.push(`Chat with it: ace spade chat ${bot.id}`);
  return lines;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
