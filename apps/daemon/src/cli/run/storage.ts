import type { Client } from "@ace/client";
import type { Args } from "../args.ts";
import { prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

/** `ace storage …` and `ace config …` (ADR 0176 §7). */

type StorageRun = (args: Args, client: Client, signal: AbortSignal) => Promise<void>;

function storage(load: () => Promise<StorageRun>) {
  return (context: CommandContext) =>
    withSession(context, context.args, async ({ client, signal }) =>
      (await load())(context.args, client, signal),
    );
}

async function config(context: CommandContext, verb: "list" | "get" | "set" | "unset") {
  const { dataDir } = await context.config();
  await prepareHome(dataDir);
  const settings = await import("../config.ts");
  const render = await import("../render/config.ts");
  const { emit } = await import("../io.ts");
  const [name, value] = context.args.words;
  if (verb === "list" || name === undefined) {
    const entries = await settings.configList(context.args, dataDir);
    return emit(context.args, entries, {
      human: render.configListLines,
      quiet: (all) => all.map((entry) => entry.key),
    });
  }
  if (verb === "get") {
    const entry = await settings.configGet(context.args, dataDir, name);
    return emit(context.args, entry, {
      human: (shown) => render.configEntryLines(shown),
      quiet: () => [],
    });
  }
  const { spadeService } = await import("../spade.ts");
  const parsed = verb === "set" ? value : undefined;
  const entry = await settings.configSet(context.args, dataDir, name, parsed, () =>
    spadeService(dataDir),
  );
  await emit(context.args, entry, {
    human: (shown) => render.configChangedLines(shown, parsed),
    quiet: () => [],
  });
}

export const storageHandlers: Handlers = {
  "storage.usage": storage(async () => (await import("../retention.ts")).storageUsage),
  "storage.plan": storage(async () => (await import("../retention.ts")).storagePlan),
  "storage.apply": storage(async () => (await import("../retention.ts")).storageApply),
  "storage.status": storage(async () => (await import("../retention.ts")).storageStatus),
  "storage.compact": storage(async () => (await import("../compact.ts")).compactCommand),
  "storage.clean": storage(async () => {
    const { cleanCommand, terminalConfirmation } = await import("../clean.ts");
    return (args, client, signal) =>
      cleanCommand(args, client, signal, terminalConfirmation(args.interactive === true));
  }),
  "config.list": (context) => config(context, "list"),
  "config.get": (context) => config(context, "get"),
  "config.set": (context) => config(context, "set"),
  "config.unset": (context) => config(context, "unset"),
};
