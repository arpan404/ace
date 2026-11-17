import {
  legacy,
  ownThread,
  prepareHome,
  withSession,
  without,
  type CommandContext,
  type Handlers,
} from "./context.ts";

/** Tools agents call from a shell: browser, sim, Codex Cloud. */
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

export const agentToolHandlers: Handlers = {
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
