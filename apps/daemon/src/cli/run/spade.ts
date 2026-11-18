import type { SpadeCall } from "../spade-bots.ts";
import { spadeCaller } from "../spade-call.ts";
import { automationHandlers } from "./automation.ts";
import { prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

/** Spade and its bots, and the Beta switches (ADR 0178 §7). */

async function color(context: CommandContext): Promise<boolean> {
  const { useColor } = await import("../input-mode.ts");
  return useColor({
    flags: context.args.flags,
    env: context.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  });
}

async function spadeSession(
  context: CommandContext,
  run: (call: SpadeCall) => Promise<void>,
): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) =>
    run(await spadeCaller(client, signal)),
  );
}

async function status(context: CommandContext): Promise<void> {
  const { dataDir } = await context.config();
  const { spadeState } = await import("../spade.ts");
  const { spadeStateLines } = await import("../render/spade.ts");
  const { emit } = await import("../io.ts");
  const state = await spadeState(context.args, dataDir, async () => {
    const { connectCli } = await import("../connection.ts");
    const session = await connectCli(dataDir, context.args);
    try {
      const { client, signal } = session;
      const setting = async (key: "beta.spade" | "spade.enabled") => {
        const result = await client.request({ type: "settings.get", key, scope: {} }, { signal });
        return result.entries.find((entry) => entry.key === key)?.value === true;
      };
      const [answer, beta, enabled] = await Promise.all([
        client.request({ type: "spade.status" }, { signal }),
        setting("beta.spade"),
        setting("spade.enabled"),
      ]);
      return { beta, enabled, status: answer.status };
    } finally {
      await session.close();
    }
  });
  const paint = await color(context);
  await emit(context.args, state, {
    human: (value) => spadeStateLines(value, paint),
    quiet: () => [],
  });
}

async function switchSpade(context: CommandContext, enabled: boolean): Promise<void> {
  const { dataDir } = await context.config();
  await prepareHome(dataDir);
  const spade = await import("../spade.ts");
  const askBeta = context.args.interactive
    ? async () => {
        const { askConfirm } = await import("../ask.ts");
        return askConfirm("Spade is hidden in Settings › Beta. Turn it on there too?", true);
      }
    : undefined;
  const result = await spade.switchSpade(
    context.args,
    dataDir,
    enabled,
    spade.spadeService(dataDir),
    askBeta,
  );
  const { spadeSwitchWords } = await import("../render/spade.ts");
  const { emit } = await import("../io.ts");
  await emit(context.args, result, { human: spadeSwitchWords, quiet: () => [] });
}

async function features(context: CommandContext, on?: boolean): Promise<void> {
  const { dataDir } = await context.config();
  await prepareHome(dataDir);
  const module = await import("../features.ts");
  const render = await import("../render/spade.ts");
  const { emit } = await import("../io.ts");
  if (on === undefined)
    return emit(context.args, await module.readFeatures(dataDir), {
      human: render.featureLines,
      quiet: (value) => module.betaFeatures.filter((feature) => value[feature]),
    });
  const feature = module.betaFeature(context.args.words[0]);
  const { spadeService } = await import("../spade.ts");
  const result = await module.switchFeature(context.args, dataDir, feature, on, () =>
    spadeService(dataDir),
  );
  await emit(context.args, render.featureJson(result), {
    human: () => render.featureWords(result),
    quiet: () => [],
  });
}

async function bots(context: CommandContext, one: boolean): Promise<void> {
  const { listBots, findBot } = await import("../spade-bots.ts");
  const render = await import("../render/spade.ts");
  const { emit } = await import("../io.ts");
  const paint = await color(context);
  await spadeSession(context, async (call) => {
    const all = await listBots(call);
    if (!one)
      return emit(context.args, render.botOrder(all), {
        human: (value) => render.botListLines(value, Date.now(), paint),
        quiet: (value) => value.map((bot) => bot.id),
      });
    const bot = findBot(all, context.args.words[0]);
    await emit(context.args, bot, {
      human: (value) => render.botLines(value, Date.now(), paint),
      quiet: (value) => [value.id],
    });
  });
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function move(context: CommandContext): Promise<void> {
  const { listBots, findBot } = await import("../spade-bots.ts");
  const { acceptThere, findMachine, moveBot, newMoveId } = await import("../spade-move.ts");
  const { option, timeoutMs } = await import("../args.ts");
  const { usageFailure } = await import("../output.ts");
  const { emit } = await import("../io.ts");
  const to = option(context.args, "to");
  if (!to) throw usageFailure("Say where with --to MACHINE.", { argument: "--to" });
  // The person's say there: through that machine's daemon, `here` being this one.
  const there = option(context.args, "target-remote");
  if (!there)
    throw usageFailure(
      `Moving needs your say on ${to} too: pass --target-remote PROFILE for it (see ace remote list), or move the bot from the app.`,
      { argument: "--target-remote" },
    );
  const targetArgs = { ...context.args, flags: { ...context.args.flags } };
  if (there === "here") delete targetArgs.flags.remote;
  else targetArgs.flags.remote = there;
  const limit = option(context.args, "timeout") === undefined ? 1_800_000 : timeoutMs(context.args);
  await withSession(context, context.args, async ({ client, signal }) => {
    const call = await spadeCaller(client, signal);
    const bot = findBot(await listBots(call), context.args.words[0]);
    const listed = await client.request(
      { type: "spade.machines", requestId: crypto.randomUUID() },
      { signal },
    );
    const { SpadeMachinesResult } = await import("@ace/protocol");
    const machine = findMachine(SpadeMachinesResult.parse(listed).machines, to);
    const id = newMoveId(crypto.randomUUID());
    await withSession(context, targetArgs, async (target) =>
      acceptThere(await spadeCaller(target.client, target.signal), id, bot.id),
    );
    const moved = await moveBot(call, bot, machine, id, limit, wait);
    await emit(context.args, moved, {
      human: (value) => [
        value.state === "done"
          ? `${value.bot.name} moved to ${value.to.name}. Its routines are paused there until you resume them, and what you allowed it here you give again there.`
          : `${value.bot.name} stays here.`,
      ],
      quiet: (value) => [value.bot.id],
    });
  });
}

export const spadeHandlers: Handlers = {
  "spade.move": move,
  "spade.status": status,
  "spade.on": (context) => switchSpade(context, true),
  "spade.off": (context) => switchSpade(context, false),
  "spade.bot.list": (context) => bots(context, false),
  "spade.bot.show": (context) => bots(context, true),
  "spade.chat": async (context) => {
    const { chatCommand } = await import("./spade-chat.ts");
    await spadeSession(context, (call) => chatCommand(context, call));
  },
  "feature.list": (context) => features(context),
  "feature.on": (context) => features(context, true),
  "feature.off": (context) => features(context, false),
  ...automationHandlers,
};
