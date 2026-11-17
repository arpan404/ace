import { CliFailure } from "../output.ts";
import { legacy, prepareHome, withSession, type CommandContext, type Handlers } from "./context.ts";

async function runtime(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return (await import("../runtime.ts")).runtimeCommand(args, context.config());
}

async function access(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return (await import("../access.ts")).accessCommand(args, context.config().dataDir);
}

async function storage(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../retention.ts")).retentionCommand(args, client, signal),
  );
}

async function settings(context: CommandContext, verb: string): Promise<void> {
  const { dataDir } = context.config();
  await prepareHome(dataDir);
  return (await import("../config.ts")).configCommand(legacy(context, ["config", verb]), dataDir);
}

/** The rescue path (ADR 0092): its own config reading, which survives bad ACE_* settings. */
async function rescue(context: CommandContext, word: "doctor" | "triage"): Promise<void> {
  const { rescueConfig } = await import("../rescue.ts");
  const rescued = rescueConfig(context.env);
  const args = legacy(context, [word]);
  if (word === "doctor") return (await import("../doctor.ts")).doctorCommand(args, rescued.config);
  return (await import("../triage.ts")).triageCommand(
    args,
    rescued.config,
    rescued.problem ? [rescued.problem] : [],
  );
}

async function bundle(context: CommandContext): Promise<void> {
  const { rescueConfig } = await import("../rescue.ts");
  const rescued = rescueConfig(context.env);
  const { diagnosticsCli } = await import("../../diagnostics-cli.ts");
  const output: string[] = [];
  const path = context.args.words[0] ?? "";
  await diagnosticsCli(
    [
      "support-bundle",
      path,
      ...(context.args.flags["include-threads"] ? ["--include-threads"] : []),
    ],
    rescued.config,
    (text) => output.push(text),
  );
  const { emit } = await import("../io.ts");
  await emit(context.args, { path }, { human: () => output.join("").trimEnd() });
}

export const machineHandlers: Handlers = {
  "daemon.start": (context) => runtime(context, ["start"]),
  "daemon.serve": (context) => runtime(context, ["serve"]),
  "daemon.stop": async (context) => {
    const args = legacy(context, ["stop"]);
    return (await import("../control.ts")).stopCommand(args, context.config().dataDir);
  },
  "daemon.status": (context) => access(context, ["status"]),
  "daemon.logs": async (context) => {
    const args = legacy(context, ["logs"]);
    return (await import("../logs.ts")).logsCommand(args, context.config().dataDir);
  },
  "daemon.token": (context) => access(context, ["token"]),
  "service.install": (context) => runtime(context, ["service", "install"]),
  "service.uninstall": (context) => runtime(context, ["service", "uninstall"]),
  "service.start": (context) => runtime(context, ["service", "start"]),
  "service.stop": (context) => runtime(context, ["service", "stop"]),
  "service.status": (context) => runtime(context, ["service", "status"]),
  "storage.usage": (context) => storage(context, ["storage", "usage"]),
  "storage.plan": (context) => storage(context, ["storage", "plan"]),
  "storage.clean": (context) => storage(context, ["clean"]),
  "storage.apply": (context) => storage(context, ["storage", "apply"]),
  "storage.status": (context) => storage(context, ["storage", "status"]),
  "storage.compact": async (context) => {
    const args = {
      ...legacy(context, ["clean"]),
      flags: { ...context.args.flags, compact: true as const },
    };
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../retention.ts")).retentionCommand(args, client, signal),
    );
  },
  "config.get": (context) => settings(context, "get"),
  "config.set": (context) => settings(context, "set"),
  doctor: (context) => rescue(context, "doctor"),
  "doctor.bundle": bundle,
  triage: (context) => rescue(context, "triage"),
  ...Object.fromEntries(
    ["update", "supervise", "migrate-check", "spade-follow", "install-artifact"].map((word) => [
      `release.${word}`,
      async () => {
        throw new CliFailure(
          "refused",
          `ace ${word} runs only in an installed release.`,
          undefined,
          {
            code: "refused",
            hint: "Install ace from acehq.dev, or run this from the installed ace.",
          },
        );
      },
    ]),
  ),
};
