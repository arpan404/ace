import type { CliBotAction, CliRunningBot } from "@ace/protocol/cli-outputs";
import type { SpadeRunningAction, SpadeRunningBot } from "@ace/ui-core/spade-chat";
import { CliFailure } from "./output.ts";
import { findBot, listBots, type SpadeCall } from "./spade-bots.ts";

/*
 * `ace bot running|stop|pause|resume|unarchive` (ADR 0200 §6.3, ADR 0178 §1): Spade's task manager from
 * the terminal, through the daemon's `spade.http` forwarding, read with the app's own parser so
 * both say the same.
 */

/** A row as `ace bot running` prints it, `usesWords` what it holds open. Pure. */
export function runningSummary(bot: SpadeRunningBot, usesWords: string): CliRunningBot {
  return {
    id: bot.id,
    kind: bot.kind,
    name: bot.name,
    state: bot.state,
    reads: bot.reads,
    doing: bot.doing,
    uses: usesWords,
    spend: {
      todayMicros: bot.spend.todayMicros,
      monthMicros: bot.spend.monthMicros,
      unusual: bot.spend.unusual,
    },
    network: {
      bytes: bot.network.sentBytes + bot.network.receivedBytes,
      hosts: bot.network.hosts,
      refused: bot.network.refused,
    },
    ...(bot.nextWake ? { nextWake: bot.nextWake } : {}),
    workers: bot.workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      doing: worker.doing,
    })),
    actions: bot.actions,
  };
}

async function summaries(bots: readonly SpadeRunningBot[]): Promise<CliRunningBot[]> {
  const { spadeRunningUsesWords } = await import("@ace/ui-core/spade-chat");
  return bots.map((bot) => runningSummary(bot, spadeRunningUsesWords(bot.uses)));
}

const unreadable = () => new CliFailure("uncertain", "Spade's answer had no running list in it.");

/** Every bot, in Spade's order. */
export async function listRunning(call: SpadeCall): Promise<CliRunningBot[]> {
  const { parseSpadeRunning } = await import("@ace/ui-core/spade-chat");
  const bots = parseSpadeRunning(await call("GET", "/v1/running"));
  if (!bots) throw unreadable();
  return summaries(bots);
}

/** Stops, pauses, resumes or unarchives the bot `ref` names (an id, a name or a start of either). */
export async function actOnBot(
  call: SpadeCall,
  ref: string | undefined,
  action: SpadeRunningAction,
): Promise<CliBotAction> {
  const bot = findBot(await listBots(call), ref);
  const body = await call("POST", `/v1/agents/${encodeURIComponent(bot.id)}/${action}`, {});
  const { parseSpadeRunningAnswer } = await import("@ace/ui-core/spade-chat");
  const answer = parseSpadeRunningAnswer(body);
  if (!answer) throw unreadable();
  const now = (await summaries(answer.bots)).find((row) => row.id === bot.id);
  return { bot: bot.id, name: bot.name, action, changed: answer.changed, ...(now ? { now } : {}) };
}
