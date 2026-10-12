import { ClientError } from "@ace/client";
import { readConfig } from "../config.ts";
import { parseArgs, type Args } from "./args.ts";
import { CliFailure, exitCodes } from "./output.ts";
import { print } from "./io.ts";
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

All commands: --json, --jq EXPR, --timeout DURATION
Mutations: --idempotency-key KEY. Waits: --tree. Run: --stream jsonl.
Exit: 0 ok, 1 failed, 2 needs-human, 3 timeout, 4 refused, 5 uncertain.
`;
export async function main(input: string[]): Promise<void> {
  let args: Args = { words: [], flags: input.includes("--json") ? { json: true } : {} };
  try {
    args = parseArgs(input);
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
    if (["start", "service"].includes(command)) return await runtimeCommand(args, config);
    if (["status", "token", "pair", "devices"].includes(command))
      return await accessCommand(args, config.dataDir);
    if (!["run", "threads", "thread", "task"].includes(command))
      throw new CliFailure("refused", "Unknown command. See ace --help.");
    const session = await connectCli(config.dataDir, args);
    try {
      if (command === "run") {
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
    if (args.flags.json || args.flags.jq || args.flags.stream === "jsonl")
      await print(
        { ...args, flags: { ...args.flags, jq: "", json: true } },
        { ok: false, status: outcome, error: message },
      );
    else process.stderr.write(`${message}\n`);
    process.exitCode = exitCodes[outcome];
  }
}
