import { usageFailure } from "../output.ts";
import {
  legacy,
  ownThread,
  prepareHome,
  withSession,
  without,
  type CommandContext,
  type Handlers,
} from "./context.ts";

/** Tools agents call from a shell: browser, sim, Codex Cloud. They know the agent's thread (§10). */
async function browser(context: CommandContext, verb: "screenshot" | "record"): Promise<void> {
  const thread = context.args.words[0] ?? ownThread(context);
  if (!thread)
    throw usageFailure(`ace browser ${verb} needs THREAD.`, {
      code: "missing_argument",
      argument: "THREAD",
      hint: `Pass the thread: ace browser ${verb} THREAD. An agent's shell has ACE_THREAD_ID.`,
    });
  const args = context.args;
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../browser.ts")).browserCommand(args, client, signal, verb, thread),
  );
}

/** `ace sim` reads as words by default; --json for JSON; `--human` and `--out` still accepted. */
async function sim(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["sim", verb], without(context.args.flags, "human"));
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../sim.ts")).simCommand(args, client, signal, ownThread(context)),
  );
}

async function cloud(context: CommandContext, verb: string): Promise<void> {
  const { dataDir } = await context.config();
  await prepareHome(dataDir);
  return (await import("../cloud.ts")).cloudCommand(
    legacy(context, ["cloud", "codex", verb]),
    dataDir,
  );
}

export const agentToolHandlers: Handlers = {
  "browser.screenshot": (context) => browser(context, "screenshot"),
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
