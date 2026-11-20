import type { CliBotDev, CliBotInit } from "@ace/protocol/cli-outputs";
import { option } from "../args.ts";
import { CliFailure, usageFailure } from "../output.ts";
import { withSession, type CommandContext, type Handlers } from "./context.ts";

/* `ace bot init|check|test|dev|publish` (ADR 0200 §9): the developer kit's handlers. */

const folderOf = (context: CommandContext) => context.args.words[0] ?? ".";
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function init(context: CommandContext): Promise<void> {
  const { initPackage, initFromBot, initLines } = await import("../bot-kit/init.ts");
  const { emit } = await import("../io.ts");
  const show = (made: CliBotInit) =>
    emit(context.args, made, { human: initLines, quiet: (value) => [value.path] });
  const from = option(context.args, "from");
  if (!from)
    return show(
      await initPackage(context.args.words[0] ?? "", {
        template: option(context.args, "template"),
        path: option(context.args, "path"),
        cwd: process.cwd(),
      }),
    );
  if (option(context.args, "template"))
    throw usageFailure("--from and --template each say what it starts as; pass one.", {
      argument: "--template",
    });
  const options = {
    name: context.args.words[0],
    path: option(context.args, "path"),
    cwd: process.cwd(),
  };
  const direct = option(context.args, "spade");
  if (direct) {
    const { directExchange } = await import("../bot-kit/dev.ts");
    return show(await initFromBot(await directExchange(direct), from, options));
  }
  const { spadeExchanger } = await import("../spade-call.ts");
  await withSession(context, context.args, async ({ client, signal }) =>
    show(await initFromBot(await spadeExchanger(client, signal), from, options)),
  );
}

async function check(context: CommandContext): Promise<void> {
  const { checkPackage, checkLines } = await import("../bot-kit/check.ts");
  const { emit } = await import("../io.ts");
  const checked = await checkPackage(folderOf(context), {
    against: option(context.args, "against"),
  });
  await emit(context.args, checked, { human: checkLines, quiet: (value) => [value.hash] });
}

async function program(context: CommandContext): Promise<string> {
  const { spadeProgram } = await import("../bot-kit/test.ts");
  const found = await spadeProgram(context.env, process.argv[1]);
  if (!found)
    throw new CliFailure("refused", "Spade's program isn't on this machine.", undefined, {
      code: "not_found",
      hint: "Set ACE_SPADE_BIN to a spade binary, or build one: cargo build -p spade-server in spade/.",
    });
  return found;
}

async function test(context: CommandContext): Promise<void> {
  const { testPackage, testLines } = await import("../bot-kit/test.ts");
  const { emit } = await import("../io.ts");
  const report = await testPackage(folderOf(context), await program(context));
  await emit(context.args, report, { human: testLines, quiet: () => [] });
}

async function dev(context: CommandContext): Promise<void> {
  const { devStep, devWatch, directExchange } = await import("../bot-kit/dev.ts");
  const { devLine } = await import("../render/bot.ts");
  const { emit } = await import("../io.ts");
  const root = folderOf(context);
  const yes = context.args.flags.yes === true;
  const confirm = async (question: string, lines: readonly string[]) => {
    if (yes) return true;
    if (!context.args.interactive) return false;
    for (const line of lines) process.stderr.write(`  ${line}\n`);
    const { askConfirm } = await import("../ask.ts");
    return askConfirm(question, true);
  };
  const json = context.mode === "json";
  const once = context.args.flags.once === true;
  const report = async (step: CliBotDev) =>
    json
      ? void process.stdout.write(`${JSON.stringify(step)}\n`)
      : emit(context.args, step, {
          human: (value) => [devLine(value, !once)],
          quiet: (v) => [v.bot],
        });
  const run = async (exchange: Parameters<typeof devStep>[1]["exchange"]) => {
    const io = { exchange, confirm, report, wait };
    if (once) {
      const step = await devStep(root, io, {});
      if (step.step === "refused")
        throw new CliFailure("needs-human", "This save asks for more than the bot has.", step, {
          code: "confirm",
          hint: "Run it in your own terminal to answer, or pass --yes.",
        });
      return report(step);
    }
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
    await devWatch(root, io, stop.signal);
  };
  const direct = option(context.args, "spade");
  if (direct) return run(await directExchange(direct));
  const { spadeExchanger } = await import("../spade-call.ts");
  await withSession(context, context.args, async ({ client, signal }) =>
    run(await spadeExchanger(client, signal)),
  );
}

async function publish(context: CommandContext): Promise<void> {
  const { checkAgainstPublished, checkPackage, marketOf, marketReads } =
    await import("../bot-kit/check.ts");
  const { testPackage } = await import("../bot-kit/test.ts");
  const root = folderOf(context);
  const checked = await checkPackage(root, { against: option(context.args, "against") });
  // Callers of the latest published version keep working, or nothing uploads (ADR 0200 §7).
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const bot: unknown = JSON.parse(await readFile(resolve(root, "bot.json"), "utf8"));
  await checkAgainstPublished(
    option(context.args, "name") ?? checked.name,
    bot,
    marketReads(marketOf(context.env)),
  );
  // The market runs a package's tests on its signer; one whose tests fail isn't listed.
  await testPackage(root, await program(context));
  const { publish: marketPublish } = await import("./market-flows.ts");
  const flags = { ...context.args.flags };
  if (!flags.name) flags.name = checked.name;
  await marketPublish({
    ...context,
    args: { ...context.args, words: ["spade-bot", root], flags },
  });
}

export const botKitHandlers: Handlers = {
  "bot.init": init,
  "bot.check": check,
  "bot.test": test,
  "bot.dev": dev,
  "bot.publish": publish,
};
