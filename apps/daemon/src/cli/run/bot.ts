import type { SpadeRunningAction } from "@ace/ui-core/spade-chat";
import { spadeCaller } from "../spade-call.ts";
import { withSession, type CommandContext, type Handlers } from "./context.ts";

/** `ace bot running|stop|pause|resume` (ADR 0200 §6.3). */

async function color(context: CommandContext): Promise<boolean> {
  const { useColor } = await import("../input-mode.ts");
  return useColor({
    flags: context.args.flags,
    env: context.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  });
}

async function running(context: CommandContext): Promise<void> {
  const { listRunning } = await import("../bot-running.ts");
  const { runningLines } = await import("../render/bot.ts");
  const { emit } = await import("../io.ts");
  const paint = await color(context);
  await withSession(context, context.args, async ({ client, signal }) => {
    const bots = await listRunning(await spadeCaller(client, signal));
    await emit(context.args, bots, {
      human: (value) => runningLines(value, Date.now(), paint),
      quiet: (value) => value.map((bot) => bot.id),
    });
  });
}

async function act(context: CommandContext, action: SpadeRunningAction): Promise<void> {
  const { actOnBot } = await import("../bot-running.ts");
  const { botActionWords } = await import("../render/bot.ts");
  const { emit } = await import("../io.ts");
  await withSession(context, context.args, async ({ client, signal }) => {
    const call = await spadeCaller(client, signal);
    const result = await actOnBot(call, context.args.words[0], action);
    await emit(context.args, result, {
      human: (value) => [botActionWords(value)],
      quiet: (value) => [value.bot],
    });
  });
}

export const botHandlers: Handlers = {
  "bot.running": running,
  "bot.stop": (context) => act(context, "stop"),
  "bot.pause": (context) => act(context, "pause"),
  "bot.resume": (context) => act(context, "resume"),
  "bot.unarchive": (context) => act(context, "unarchive"),
};
