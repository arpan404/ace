import { randomUUID } from "node:crypto";
import type { Client } from "@ace/client";
import type { SpadeHttpResult } from "@ace/protocol";
import { CliFailure } from "../output.ts";
import type { SpadeCall } from "../spade-bots.ts";
import { automationHandlers } from "./automation.ts";
import { prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

/** Spade and its bots, and the Beta switches (ADR 0176 §7). */

async function color(context: CommandContext): Promise<boolean> {
  const { useColor } = await import("../input-mode.ts");
  return useColor({
    flags: context.args.flags,
    env: context.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  });
}

type SpadeError = Extract<SpadeHttpResult["result"], { kind: "error" }>;

/** Why the daemon didn't forward a request, as one sentence and the next step. */
function spadeFailure(error: SpadeError): CliFailure {
  if (error.code === "hidden")
    return new CliFailure("refused", "Spade is hidden: Settings › Beta has it off.", undefined, {
      code: "turned_off",
      hint: "Turn it on with ace spade on.",
    });
  if (error.code === "unavailable")
    return new CliFailure("refused", "Spade isn't running.", undefined, {
      code: "refused",
      hint: "See why with ace spade status.",
    });
  if (error.code === "forbidden")
    return new CliFailure("refused", "This device may not talk to Spade.", undefined, {
      code: "forbidden",
    });
  return new CliFailure("failed", `Spade didn't answer: ${error.message}`, undefined, {
    code: "failed",
    hint: "See how Spade is with ace spade status.",
  });
}

/** One Spade API call through the daemon's `spade.http` (ADR 0121). */
async function spadeCaller(client: Client, signal: AbortSignal): Promise<SpadeCall> {
  const { spadeExchange } = await import("@ace/client/spade-http");
  return async (method, path, body) => {
    const answer = await spadeExchange(
      client,
      { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { id: () => randomUUID(), signal },
    );
    if (answer.kind === "error") throw spadeFailure(answer);
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const said = /"(?:error|message)"\s*:\s*"([^"]{1,300})"/.exec(answer.body)?.[1];
    throw new CliFailure(
      answer.status === 404 ? "refused" : "failed",
      said ? `Spade said: ${said}` : `Spade answered ${answer.status}.`,
      undefined,
      { code: answer.status === 404 ? "not_found" : "failed" },
    );
  };
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
  const { dataDir } = context.config();
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
  const { dataDir } = context.config();
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
  const { dataDir } = context.config();
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

export const spadeHandlers: Handlers = {
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
