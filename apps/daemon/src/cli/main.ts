import { remoteCommand, redeemCommand } from "./remote.ts";
import { logsCommand } from "./logs.ts";
import { cloudCommand } from "./cloud.ts";
import { browserCommand } from "./browser.ts";
import { automationCommand } from "./automations.ts";
import { controlCommand, stopCommand } from "./control.ts";
import { providersCommand, loginCommand } from "./providers.ts";
import { ClientError } from "@ace/client";
import { readConfig } from "../config.ts";
import { option, parseArgs, type Args } from "./args.ts";
import { CliFailure, exitCodes } from "./output.ts";
import { print, validateOutput } from "./io.ts";
import { runtimeCommand } from "./runtime.ts";
import { accessCommand } from "./access.ts";
import { connectCli } from "./connection.ts";
import { runCommand } from "./work.ts";
import { listThreads, threadCommand, waitThread } from "./threads.ts";
import { taskCommand } from "./tasks.ts";
const help = `ace run [PROMPT|-] [--provider codex|claude] [--project ID|PATH] [--worktree] [--model MODEL]
ace threads list [--project ID]
ace thread read|send|steer|wait|approve|deny|cancel|interrupt ID [TEXT]
ace task spawn [PROMPT|-] --parent ID [--provider PROVIDER] [--model MODEL]
ace task status|wait|cancel ID
ace start|status|token|pair [SCOPES]|devices list|revoke ID
ace service install|uninstall|start|stop|status
ace accounts add|list|status|discover
ace doctor|support-bundle PATH
ace stop|kill-all [--thread ID|--provider PROVIDER|--project ID]
ace mcp enroll --scope read|operate --ttl DURATION [--project ID]
ace mcp list|revoke ID
ace capabilities|providers status|login codex|claude
ace serve|service install --linger
ace remote add NAME HTTPS_ORIGIN --fingerprint PIN --device ID --token-file PATH
ace remote list|use|remove NAME
ace pair redeem [URL|-] --profile NAME
ace cloud codex exec|list|status|diff|apply [PROMPT|TASK_ID]
ace logs [-f]
ace browser shot|record THREAD [--url URL] [--output PATH]
ace automation list|run ID

All commands: --json, --jq EXPR, --timeout DURATION
Mutations: --idempotency-key KEY. Waits: --tree. Run: --stream jsonl.
Exit: 0 ok, 1 failed, 2 needs-human, 3 timeout, 4 refused, 5 uncertain.
`;
export async function main(input: string[]): Promise<void> {
  let args: Args = { words: [], flags: input.includes("--json") ? { json: true } : {} };
  try {
    args = parseArgs(input);
    await validateOutput(args);
    if (args.flags.help) {
      await print(args, args.flags.json || args.flags.jq ? { help } : help.trimEnd());
      return;
    }
    const command = args.words[0] ?? "start";
    const config = readConfig();
    if (command === "accounts") {
      const { runAccountsCommand } = await import("@ace/accounts");
      const lines: string[] = [];
      await runAccountsCommand([...args.words, ...(args.flags.console ? ["--console"] : [])], {
        write: (value) => lines.push(value),
        progress: (value) =>
          (args.flags.json || args.flags.jq ? process.stderr : process.stdout).write(value),
        loginOutput: args.flags.json || args.flags.jq ? "stderr" : "stdout",
      });
      const output = lines.flatMap((line) => line.trim().split("\n")).filter(Boolean);
      if (args.flags.json || args.flags.jq) {
        const values = output.map((line): unknown => {
          try {
            return JSON.parse(line);
          } catch {
            return { message: line };
          }
        });
        await print(args, values.length === 1 ? values[0] : values);
      } else process.stdout.write(lines.join(""));
      return;
    }
    if (["doctor", "support-bundle"].includes(command)) {
      const { diagnosticsCli } = await import("../diagnostics-cli.ts");
      const output: string[] = [];
      await diagnosticsCli(
        [
          ...args.words,
          ...(command === "doctor" && (args.flags.json || args.flags.jq) ? ["--json"] : []),
          ...(args.flags["include-threads"] ? ["--include-threads"] : []),
        ],
        config,
        (text) => output.push(text),
      );
      if (args.flags.json || args.flags.jq)
        await print(
          args,
          command === "doctor" ? JSON.parse(output.join("")) : { path: args.words[1] },
        );
      else process.stdout.write(output.join(""));
      return;
    }
    if (command === "remote") return await remoteCommand(args, config.dataDir);
    if (command === "pair" && args.words[1] === "redeem")
      return await redeemCommand(args, config.dataDir);
    if (command === "logs") return await logsCommand(args, config.dataDir);
    if (command === "cloud") return await cloudCommand(args, config.dataDir);
    if (command === "stop") return await stopCommand(args, config.dataDir);
    if (["start", "serve", "service"].includes(command)) return await runtimeCommand(args, config);
    if (["status", "token", "pair", "devices"].includes(command))
      return await accessCommand(args, config.dataDir);
    if (
      ![
        "run",
        "threads",
        "thread",
        "task",
        "kill-all",
        "mcp",
        "capabilities",
        "providers",
        "login",
        "browser",
        "automation",
      ].includes(command)
    )
      throw new CliFailure("refused", "Unknown command. See ace --help.");
    const session = await connectCli(config.dataDir, args);
    try {
      if (command === "browser") await browserCommand(args, session.client, session.signal);
      else if (command === "automation")
        await automationCommand(args, session.client, session.signal);
      else if (command === "kill-all" || command === "mcp")
        await controlCommand(args, session.client, session.signal);
      else if (command === "capabilities" || command === "providers")
        await providersCommand(args, session.client, session.signal);
      else if (command === "login") await loginCommand(args, session.client, session.signal);
      else if (command === "run") {
        if (session.remote && !option(args, "project"))
          throw new CliFailure("refused", "Remote runs require --project WORKSPACE_ID");
        const id = await runCommand(args, session.client, session.signal);
        if (args.flags.stream === "jsonl")
          await waitThread(
            { ...args, flags: { ...args.flags, tree: true } },
            session.client,
            id,
            session.signal,
          );
      } else if (command === "threads") await listThreads(args, session.client, session.signal);
      else if (command === "thread") await threadCommand(args, session.client, session.signal);
      else await taskCommand(args, session.client, session.signal);
    } finally {
      await session.close();
    }
  } catch (error) {
    const outcome =
      error instanceof CliFailure
        ? error.outcome
        : error instanceof ClientError
          ? error.code === "timeout"
            ? "timeout"
            : error.code === "auth" || error.code === "not_dispatched"
              ? "refused"
              : "uncertain"
          : "refused";
    const message = error instanceof Error ? error.message : "Command failed";
    const evidence = error instanceof CliFailure ? error.evidence : undefined;
    const failure = {
      ok: false,
      status: outcome,
      error: message,
      ...(evidence !== undefined ? { admission: evidence } : {}),
    };
    process.exitCode = exitCodes[outcome];
    if (args.flags.json || args.flags.jq || args.flags.stream === "jsonl")
      await print({ ...args, flags: { ...args.flags, jq: "", json: true } }, failure).catch(() => {
        process.stderr.write(`${JSON.stringify(failure)}\n`);
      });
    else
      process.stderr.write(
        `${message}\n${evidence === undefined ? "" : `${JSON.stringify(evidence)}\n`}`,
      );
  }
}
