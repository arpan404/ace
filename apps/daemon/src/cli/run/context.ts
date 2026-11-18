import type { Client } from "@ace/client";
import type { Config } from "../../config.ts";
import type { Args } from "../args.ts";
import type { CommandSpec } from "../commands/spec.ts";
import type { CommandTable } from "../commands/table.ts";
import type { OutputMode } from "../input-mode.ts";
import { CliFailure } from "../output.ts";
import type { Parsed } from "../parse.ts";

/** What a command's handler gets (ADR 0178 §14): the parsed line and how to reach ace. */
export interface CommandContext {
  readonly command: CommandSpec;
  readonly parsed: Parsed;
  /** Positional arguments only, plus every flag. */
  readonly args: Args;
  readonly mode: OutputMode;
  readonly env: NodeJS.ProcessEnv;
  readonly table: CommandTable;
  /** The daemon's config; loaded and read on first use, so offline commands never need it. */
  readonly config: () => Promise<Config>;
  /** The ace home alone, without loading the config (the interactive home's first paint). */
  readonly dataDir: () => string;
}

export type Handler = (context: CommandContext) => Promise<void>;
export type Handlers = Readonly<Record<string, Handler>>;

/**
 * The words an older command module expects, in front of the positional arguments: the bridge
 * between the table's grammar and modules written for the first CLI.
 */
export function legacy(
  context: CommandContext,
  words: readonly string[],
  flags: Record<string, string | true> = context.args.flags,
): Args {
  return {
    ...context.args,
    words: [...words, ...context.args.words],
    flags,
  };
}

/** The flags without the ones a module doesn't know, which the table took care of. */
export function without(
  flags: Readonly<Record<string, string | true>>,
  ...names: string[]
): Record<string, string | true> {
  return Object.fromEntries(Object.entries(flags).filter(([name]) => !names.includes(name)));
}

export interface Session {
  readonly client: Client;
  readonly signal: AbortSignal;
  readonly remote: boolean;
}

/** One connection to the daemon (or the selected remote) for the length of `run`. */
export async function withSession(
  context: CommandContext,
  args: Args,
  run: (session: Session) => Promise<void>,
): Promise<void> {
  const { connectCli } = await import("../connection.ts");
  const session = await connectCli((await context.config()).dataDir, args);
  try {
    await run(session);
  } finally {
    await session.close();
  }
}

/** Settles the home's format for a command that writes there without a daemon (ADR 0081). */
export async function prepareHome(dataDir: string): Promise<void> {
  const { NewerDataError, prepareDaemonHome } = await import("@ace/service");
  try {
    prepareDaemonHome(dataDir);
  } catch (error) {
    if (error instanceof NewerDataError) throw new CliFailure("newer-data", error.message);
    throw error;
  }
}

/** The thread an agent's own shell runs in, unless the command named one. */
export function ownThread(context: CommandContext): string | undefined {
  const named = context.args.flags.thread;
  if (typeof named === "string") return named;
  const own = context.env.ACE_THREAD_ID?.trim();
  return own ? own : undefined;
}
