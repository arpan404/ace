import {
  legacy,
  ownThread,
  prepareHome,
  withSession,
  without,
  type CommandContext,
  type Handlers,
} from "./context.ts";

/** Spade, Beta switches, automations, the market's local checks and maintainer tools, and the agent tools. */

async function spade(context: CommandContext, verb: string): Promise<void> {
  const { dataDir } = context.config();
  await prepareHome(dataDir);
  return (await import("../spade.ts")).spadeCommand(legacy(context, ["spade", verb]), dataDir);
}

async function features(context: CommandContext, words: string[]): Promise<void> {
  const { dataDir } = context.config();
  await prepareHome(dataDir);
  return (await import("../features.ts")).featuresCommand(legacy(context, words), dataDir);
}

async function automation(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["automation", verb]);
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../automations.ts")).automationCommand(args, client, signal),
  );
}

async function maintainer(context: CommandContext, verb: string): Promise<void> {
  return (await import("../market.ts")).marketCommand(legacy(context, ["market", verb]));
}

async function browser(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["browser", verb]);
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../browser.ts")).browserCommand(args, client, signal),
  );
}

/** `ace sim` reads as words by default now, and knows the agent's own thread (§10). */
async function sim(context: CommandContext, verb: string): Promise<void> {
  const { flags } = context.args;
  const thread = ownThread(context);
  const output = flags.output ?? flags.out;
  const args = legacy(context, ["sim", verb], {
    ...without(flags, "output", "out", "human", "quiet"),
    ...(thread ? { thread } : {}),
    ...(typeof output === "string" ? { out: output } : {}),
    ...(context.mode === "json" ? {} : { human: true }),
  });
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../sim.ts")).simCommand(args, client, signal),
  );
}

async function cloud(context: CommandContext, verb: string): Promise<void> {
  const { dataDir } = context.config();
  await prepareHome(dataDir);
  return (await import("../cloud.ts")).cloudCommand(
    legacy(context, ["cloud", "codex", verb]),
    dataDir,
  );
}

const maintainerVerbs = [
  "keygen",
  "sign",
  "review",
  "feature",
  "revoke",
  "reports",
  "collection",
  "publisher",
  "block",
  "block-file",
  "block-pattern",
  "appeals",
  "appeal",
  "verify",
  "unverify",
  "official",
];

export const toolHandlers: Handlers = {
  "spade.on": (context) => spade(context, "on"),
  "spade.off": (context) => spade(context, "off"),
  "feature.list": (context) => features(context, ["features"]),
  "feature.on": (context) => features(context, ["features", "on"]),
  "feature.off": (context) => features(context, ["features", "off"]),
  "automation.list": (context) => automation(context, "list"),
  "automation.run": (context) => automation(context, "run"),
  "market.check": async (context) => {
    const words = context.args.words.length ? context.args.words : ["."];
    const args = { ...context.args, words: ["marketplace", "check", ...words] };
    return (await import("../market.ts")).marketplaceCommand(args);
  },
  ...Object.fromEntries(
    maintainerVerbs.map((verb) => [
      `market.maintainer.${verb}`,
      (context: CommandContext) => maintainer(context, verb),
    ]),
  ),
  "browser.screenshot": (context) => browser(context, "shot"),
  "browser.record": (context) => browser(context, "record"),
  ...Object.fromEntries(
    ["list", "start", "stop", "ui", "act", "screenshot", "logs"].map((verb) => [
      `sim.${verb}`,
      (context: CommandContext) => sim(context, verb),
    ]),
  ),
  ...Object.fromEntries(
    ["exec", "list", "status", "diff", "apply"].map((verb) => [
      `cloud.codex.${verb}`,
      (context: CommandContext) => cloud(context, verb),
    ]),
  ),
};
