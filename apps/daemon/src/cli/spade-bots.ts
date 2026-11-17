import type { CliSpadeBot } from "@ace/protocol/cli-outputs";
import type { SpadeMethod } from "@ace/protocol";
import type { SpadeAgent } from "@ace/ui-core/spade-chat";
import { CliFailure, usageFailure } from "./output.ts";

/**
 * Spade's bots and their conversations from the CLI (ADR 0176 §7), through the daemon's
 * `spade.http` forwarding (ADR 0121): the same Spade API the app's Spade pages use. Spade owns
 * the bodies; they're read leniently with the app's own parsers.
 */

/** One request to Spade; returns the body of a 2xx answer. */
export type SpadeCall = (method: SpadeMethod, path: string, body?: unknown) => Promise<string>;

/** A bot as `ace spade bot` prints it. Pure. */
export function botSummary(agent: SpadeAgent): CliSpadeBot {
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    task: agent.task,
    model: agent.model,
    conversation: agent.conversation,
    state: agent.state,
    ...(agent.waitingFor ? { waitingFor: agent.waitingFor } : {}),
    ...(agent.status ? { status: agent.status } : {}),
    ...(agent.problem ? { problem: agent.problem } : {}),
    unseen: agent.unseen,
    pinned: agent.pinnedAt !== undefined,
    lastActivity: agent.lastActivity,
    ...(agent.lastMessage
      ? {
          lastMessage: {
            from: agent.lastMessage.from,
            text: agent.lastMessage.text,
            at: agent.lastMessage.at,
          },
        }
      : {}),
    ...(agent.parent ? { parent: agent.parent } : {}),
  };
}

export async function listBots(call: SpadeCall): Promise<CliSpadeBot[]> {
  const { parseSpadeAgents } = await import("@ace/ui-core/spade-chat");
  const agents = parseSpadeAgents(await call("GET", "/v1/agents"));
  if (!agents) throw new CliFailure("uncertain", "Spade's answer had no bots in it.");
  return agents.map(botSummary);
}

/**
 * A BOT argument: an id, a name (any case), or an unambiguous start of either. No argument is
 * Spade's main bot.
 */
export function findBot(bots: readonly CliSpadeBot[], ref: string | undefined): CliSpadeBot {
  if (ref === undefined) {
    const main = bots.find((bot) => bot.kind === "main");
    if (main) return main;
    throw new CliFailure("refused", "Spade has no main bot yet.", undefined, {
      code: "not_found",
      hint: "Name a bot: see them with ace spade bot list.",
    });
  }
  const typed = ref.toLowerCase();
  const exact = bots.filter((bot) => bot.id === ref || bot.name.toLowerCase() === typed);
  if (exact.length === 1 && exact[0]) return exact[0];
  const starts = bots.filter(
    (bot) => bot.id.startsWith(ref) || bot.name.toLowerCase().startsWith(typed),
  );
  if (starts.length === 1 && starts[0]) return starts[0];
  if (starts.length > 1 || exact.length > 1)
    throw usageFailure(`More than one bot matches ${ref}.`, {
      code: "bad_argument",
      argument: "BOT",
      hint: `Use its id: ${[...exact, ...starts].map((bot) => bot.id).join(", ")}.`,
    });
  throw new CliFailure("refused", `Spade has no bot ${ref}.`, undefined, {
    code: "not_found",
    argument: "BOT",
    hint: "See your bots with ace spade bot list.",
  });
}

export interface ChatClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type ChatOutcome =
  | { kind: "reply"; bot: CliSpadeBot; text: string }
  | { kind: "waiting"; bot: CliSpadeBot }
  | { kind: "failed"; bot: CliSpadeBot; problem: string }
  | { kind: "timeout"; bot: CliSpadeBot };

/**
 * Sends `text` into the bot's conversation, then watches its roster row until it answers,
 * stops on the person (a question or approval, exit 2), fails, or `deadline` passes.
 */
export async function chatOnce(
  call: SpadeCall,
  bot: CliSpadeBot,
  text: string,
  clock: ChatClock,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatOutcome> {
  const sentAt = clock.now();
  await call("POST", `/v1/conversations/${encodeURIComponent(bot.conversation)}/messages`, {
    text,
  });
  let seen = bot;
  let started = false;
  while (clock.now() < deadline) {
    await clock.sleep(started ? 1000 : 400, signal);
    const current = (await listBots(call)).find((candidate) => candidate.id === bot.id);
    if (!current)
      throw new CliFailure("refused", `${bot.name} is no longer in Spade.`, undefined, {
        code: "not_found",
      });
    seen = current;
    if (current.state === "working") started = true;
    if (current.state === "waiting") return { kind: "waiting", bot: current };
    const last = current.lastMessage;
    if (current.state === "idle" && last?.from === "agent" && last.at >= sentAt)
      return { kind: "reply", bot: current, text: last.text };
    if (current.state === "idle" && current.problem && (started || current.lastActivity >= sentAt))
      return { kind: "failed", bot: current, problem: current.problem };
  }
  return { kind: "timeout", bot: seen };
}
