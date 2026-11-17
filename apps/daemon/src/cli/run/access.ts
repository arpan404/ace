import { prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

/** Machines, devices, remote profiles and outside MCP clients (ADR 0176 §7). */

function session<T>(
  context: CommandContext,
  run: (client: import("@ace/client").Client, signal: AbortSignal) => Promise<T>,
): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    await run(client, signal);
  });
}

async function device(context: CommandContext, verb: "list" | "pair" | "revoke") {
  return (await import("../access.ts")).deviceCommand(
    context.args,
    (await context.config()).dataDir,
    verb,
  );
}

async function remote(context: CommandContext, verb: "list" | "add" | "use" | "remove") {
  const { dataDir } = await context.config();
  await prepareHome(dataDir);
  const module = await import("../remote.ts");
  const link = context.args.flags.link;
  if (verb === "add" && typeof link === "string")
    return module.redeemCommand(context.args, dataDir, link);
  return module.remoteCommand(context.args, dataDir, verb);
}

export const accessHandlers: Handlers = {
  "machine.list": (context) =>
    session(context, async (client, signal) =>
      (await import("../machines.ts")).machineList(context.args, client, signal),
    ),
  "device.list": (context) => device(context, "list"),
  "device.pair": (context) => device(context, "pair"),
  "device.revoke": (context) => device(context, "revoke"),
  "remote.list": (context) => remote(context, "list"),
  "remote.add": (context) => remote(context, "add"),
  "remote.use": (context) => remote(context, "use"),
  "remote.remove": (context) => remote(context, "remove"),
  ...Object.fromEntries(
    (["list", "add", "revoke"] as const).map((verb) => [
      `mcp.${verb}`,
      (context: CommandContext) =>
        session(context, async (client, signal) =>
          (await import("../mcp.ts")).mcpGrantCommand(context.args, client, signal, verb),
        ),
    ]),
  ),
  ...Object.fromEntries(
    (["list", "allow", "deny"] as const).map((verb) => [
      `mcp.request.${verb}`,
      (context: CommandContext) =>
        session(context, async (client, signal) =>
          (await import("../mcp.ts")).mcpRequestCommand(context.args, client, signal, verb),
        ),
    ]),
  ),
};
