import { CliFailure } from "../output.ts";
import { legacy, type CommandContext, type Handlers } from "./context.ts";
import { storageHandlers } from "./storage.ts";

/** `ace start` and `ace serve`: their old module, unchanged, so their bytes never move. */
async function runtime(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return (await import("../runtime.ts")).runtimeCommand(args, await context.config());
}

/** Whether colour may mark state on stdout (ADR 0178 §3). */
async function color(context: CommandContext): Promise<boolean> {
  const { useColor } = await import("../input-mode.ts");
  return useColor({
    flags: context.args.flags,
    env: context.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  });
}

type ServiceVerb = "install" | "uninstall" | "start" | "stop" | "status";

/** `ace service …`: a machine entry point; its JSON is the service manager's answer, as ever. */
async function service(context: CommandContext, verb: ServiceVerb): Promise<void> {
  const { dataDir } = await context.config();
  const { serviceCommand } = await import("@ace/service");
  let state: { active: boolean; linger?: true };
  try {
    state = await serviceCommand(dataDir, [
      verb,
      ...(verb === "install" && context.args.flags.linger ? ["--linger"] : []),
    ]);
  } catch (error) {
    throw new CliFailure(
      "failed",
      error instanceof Error ? error.message : String(error),
      undefined,
      {
        code: "failed",
        hint: "See what's wrong with ace doctor.",
      },
    );
  }
  const { emit } = await import("../io.ts");
  const { serviceLines } = await import("../render/daemon.ts");
  await emit(context.args, state, { human: (value) => serviceLines(verb, value), quiet: () => [] });
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

/** `ace doctor bundle PATH` (`ace support-bundle`): on the rescue path, like doctor itself. */
async function bundle(context: CommandContext): Promise<void> {
  const { rescueConfig } = await import("../rescue.ts");
  const rescued = rescueConfig(context.env);
  const { diagnosticsCli } = await import("../../diagnostics-cli.ts");
  const path = context.args.words[0] ?? "";
  const written: string[] = [];
  try {
    await diagnosticsCli(
      [
        "support-bundle",
        path,
        ...(context.args.flags["include-threads"] ? ["--include-threads"] : []),
      ],
      rescued.config,
      (text) => written.push(text),
    );
  } catch (error) {
    const exists = error instanceof Error && Reflect.get(error, "code") === "EEXIST";
    throw new CliFailure(
      "failed",
      exists
        ? `${path} already exists, so no bundle was written.`
        : `The support bundle couldn't be written: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      {
        code: "failed",
        argument: "PATH",
        hint: exists ? "Pass a new path." : "Run ace triage to report it.",
      },
    );
  }
  const { emit } = await import("../io.ts");
  await emit(context.args, { path }, { human: () => written.join("").trimEnd() });
}

export const machineHandlers: Handlers = {
  "daemon.start": (context) => runtime(context, ["start"]),
  "daemon.serve": (context) => runtime(context, ["serve"]),
  "daemon.stop": async (context) => {
    const args = legacy(context, ["stop"]);
    return (await import("../daemon-stop.ts")).stopCommand(args, (await context.config()).dataDir);
  },
  "daemon.status": async (context) => {
    const { daemonHealth } = await import("../daemon-health.ts");
    const { healthLines } = await import("../render/daemon.ts");
    const { emit } = await import("../io.ts");
    await emit(context.args, await daemonHealth((await context.config()).dataDir), {
      human: healthLines,
      quiet: () => [],
    });
  },
  "daemon.logs": async (context) => {
    const { logsCommand } = await import("../logs.ts");
    return logsCommand(context.args, (await context.config()).dataDir, await color(context));
  },
  "daemon.token": async (context) => {
    const { readLocalToken } = await import("../../local-token.ts");
    const { emit } = await import("../io.ts");
    let token: string;
    try {
      token = readLocalToken((await context.config()).dataDir);
    } catch {
      throw new CliFailure("refused", "This machine has no host token yet.", undefined, {
        code: "not_found",
        hint: "ace makes one when the daemon first starts: ace start.",
      });
    }
    await emit(
      context.args,
      { token },
      { human: (value) => value.token, quiet: (value) => [value.token] },
    );
  },
  "service.install": (context) => service(context, "install"),
  "service.uninstall": (context) => service(context, "uninstall"),
  "service.start": (context) => service(context, "start"),
  "service.stop": (context) => service(context, "stop"),
  "service.status": (context) => service(context, "status"),
  ...storageHandlers,
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
