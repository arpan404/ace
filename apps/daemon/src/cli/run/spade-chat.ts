import { setTimeout as delay } from "node:timers/promises";
import { option, timeoutMs } from "../args.ts";
import { emit, prompt } from "../io.ts";
import { CliFailure, usageFailure } from "../output.ts";
import {
  chatOnce,
  findBot,
  listBots,
  type ChatClock,
  type ChatOutcome,
  type SpadeCall,
} from "../spade-bots.ts";
import type { CommandContext } from "./context.ts";

/** `ace spade chat [BOT] [TEXT|-]`: one message and its reply, or a conversation on a terminal. */

const realClock: ChatClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
};

/** The outcome of one message as an exit: a reply prints; anything else says what to do. */
function settle(outcome: ChatOutcome): string {
  const name = outcome.bot.name;
  if (outcome.kind === "reply") return outcome.text;
  if (outcome.kind === "waiting")
    throw new CliFailure(
      "needs-human",
      `${name} is waiting on you for ${outcome.bot.waitingFor === "approval" ? "an approval" : "an answer"}.`,
      undefined,
      { code: "needs_human", hint: "Answer it in the app's Spade, then carry on here." },
    );
  if (outcome.kind === "failed")
    throw new CliFailure("failed", `${name} couldn't reply: ${outcome.problem}`, undefined, {
      code: "failed",
    });
  throw new CliFailure("timeout", `${name} hasn't replied yet; it may still.`, undefined, {
    code: "timeout",
    hint: `See its reply later with ace spade bot show ${outcome.bot.id}.`,
  });
}

export async function chatCommand(context: CommandContext, call: SpadeCall): Promise<void> {
  const { args } = context;
  const bot = findBot(await listBots(call), args.words[0]);
  // One message and no limit unless asked: a person's reply can take minutes.
  const limit = option(args, "timeout") === undefined ? 600_000 : timeoutMs(args);
  const signal = new AbortController().signal;
  if (args.words[1] !== undefined) {
    const text = await prompt(args, 1);
    const reply = settle(await chatOnce(call, bot, text, realClock, Date.now() + limit, signal));
    await emit(
      args,
      { bot: bot.id, conversation: bot.conversation, reply },
      { human: (value) => value.reply ?? "", quiet: () => [] },
    );
    return;
  }
  if (!args.interactive)
    throw usageFailure("ace spade chat needs TEXT off a terminal.", {
      code: "missing_argument",
      argument: "TEXT",
      hint: `Pass it, or - to read stdin: ace spade chat ${bot.id} "…".`,
    });
  const { askText } = await import("../ask.ts");
  process.stderr.write(`Talking with ${bot.name}. Ctrl-C to leave.\n`);
  for (;;) {
    let text: string;
    try {
      text = await askText("You", `A message for ${bot.name}`);
    } catch (error) {
      // Ctrl-C at the prompt is how a person leaves.
      if (error instanceof CliFailure && error.outcome === "failed") return;
      throw error;
    }
    try {
      const reply = settle(
        await chatOnce(call, bot, text, realClock, Number.POSITIVE_INFINITY, signal),
      );
      await emit(args, reply, { human: (value) => [`${bot.name}:`, value, ""] });
    } catch (error) {
      // Waiting on the person is said and the conversation goes on; anything else ends it.
      if (!(error instanceof CliFailure) || error.outcome !== "needs-human") throw error;
      process.stderr.write(`${error.message} ${error.detail.hint ?? ""}\n`);
    }
  }
}
