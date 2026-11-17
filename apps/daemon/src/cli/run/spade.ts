import { legacy, prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

/** Spade, Beta switches and automations. */
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

export const spadeHandlers: Handlers = {
  "spade.on": (context) => spade(context, "on"),
  "spade.off": (context) => spade(context, "off"),
  "feature.list": (context) => features(context, ["features"]),
  "feature.on": (context) => features(context, ["features", "on"]),
  "feature.off": (context) => features(context, ["features", "off"]),
  "automation.list": (context) => automation(context, "list"),
  "automation.run": (context) => automation(context, "run"),
};
