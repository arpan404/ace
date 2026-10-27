import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

/*
 * Commands from agents on other machines (ADR 0105): what a call may ask for, where it may run,
 * what environment it sees and how much output comes back. Pure: no processes, no filesystem.
 */

/** A foreground run waits at most this long; longer work runs in the background. */
export const maxForegroundSeconds = 600;
export const defaultTimeoutSeconds = 120;
/** A background job ends after this long unless it ended or was stopped first. */
export const maxBackgroundSeconds = 24 * 60 * 60;
/** The tail of each stream a foreground run returns. */
export const foregroundTailBytes = 64 * 1024;
/** The tail of each stream a background job keeps for `command_output`. */
export const backgroundTailBytes = 1024 * 1024;
export const maxPageBytes = 64 * 1024;

const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine((name) => !daemonOwned(name), "ace's own settings can't be set");
const JobId = z.string().regex(/^job-[a-z0-9-]{1,64}$/);

export const CommandRunArgs = z.strictObject({
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("A project there, by id or name from machines. Default: its only project."),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Folder to run in, relative to the project root (or an absolute path in the project or one of its worktrees). Default: the root.",
    ),
  command: z
    .string()
    .min(1)
    .max(32 * 1024)
    .describe("One command line for that machine's login shell (PowerShell on Windows)."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(maxBackgroundSeconds)
    .optional()
    .describe(
      `Default ${defaultTimeoutSeconds}; at most ${maxForegroundSeconds} unless background. Its whole process tree is stopped then.`,
    ),
  env: z
    .record(EnvName, z.string().max(4096))
    .refine((env) => Object.keys(env).length <= 32, "At most 32 variables")
    .optional()
    .describe('Extra environment variables, e.g. {CI: "1"}.'),
  background: z
    .boolean()
    .optional()
    .describe(
      "Start it and return a jobId at once, for dev servers and long builds. Read it with command_status and command_output.",
    ),
});
export type CommandRunArgs = z.infer<typeof CommandRunArgs>;
export const CommandJobArgs = z.strictObject({
  jobId: JobId.describe("From command_run with background: true."),
});
export const CommandOutputArgs = z.strictObject({
  jobId: JobId.describe("From command_run with background: true."),
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Byte offset in all the stream wrote. Default: its latest page."),
  maxBytes: z.number().int().min(1).max(maxPageBytes).default(maxPageBytes),
});

/** The timeout a run gets, or why it can't have it. */
export function timeoutFor(args: CommandRunArgs): number | { refused: string } {
  const seconds = args.timeoutSeconds ?? (args.background ? undefined : defaultTimeoutSeconds);
  if (!args.background && seconds !== undefined && seconds > maxForegroundSeconds)
    return {
      refused: `A command waits at most ${maxForegroundSeconds} seconds. Pass background: true for longer work, then read it with command_status and command_output.`,
    };
  return seconds ?? maxBackgroundSeconds;
}

/** Keys the daemon reads its own configuration and secrets from; commands never see them. */
export function daemonOwned(name: string): boolean {
  return /^ACE_/i.test(name);
}

/**
 * What a command sees, as changes to `base`: the environment a local agent's shell has (this
 * daemon's, which providers inherit) without ace's own `ACE_*` settings, plus the caller's
 * additions. Removed keys are set to undefined, which a spawn leaves out.
 */
export function commandEnv(
  base: NodeJS.ProcessEnv,
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(base)) if (daemonOwned(name)) env[name] = undefined;
  return { ...env, ...additions };
}

/**
 * Where `cwd` points inside `roots` (the project, then its worktrees), without following links:
 * relative paths are taken from the first root, absolute ones must lie inside one. `..` escapes
 * are refused; links are checked by the caller once the path is resolved on disk.
 */
export function placeCwd(
  roots: readonly string[],
  cwd: string | undefined,
): { root: string; path: string } | undefined {
  const [first] = roots;
  if (first === undefined) return undefined;
  if (cwd === undefined) return { root: first, path: first };
  if (!isAbsolute(cwd)) {
    const path = resolve(first, cwd);
    return inside(first, path) ? { root: first, path } : undefined;
  }
  const path = resolve(cwd);
  const root = roots.find((candidate) => inside(candidate, path));
  return root === undefined ? undefined : { root, path };
}

/** Whether `path` is `root` or below it. Both must be absolute and resolved. */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** How the platform's shell runs one command line. */
export function shellInvocation(
  platform: NodeJS.Platform,
  shell: string,
  command: string,
): { command: string; args: string[] } {
  if (platform !== "win32") return { command: shell, args: ["-l", "-c", command] };
  const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase();
  if (name === "cmd.exe" || name === "cmd") return { command: shell, args: ["/d", "/c", command] };
  return {
    command: shell,
    args: ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

/**
 * The last `limit` bytes a stream wrote, and how many it wrote in all, so a reader knows what
 * was dropped. Work is proportional to each chunk, never to history.
 */
export class OutputTail {
  private chunks: Buffer[] = [];
  private kept = 0;
  private limit: number;
  /** Every byte the stream wrote. */
  total = 0;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(chunk: Buffer): void {
    this.total += chunk.length;
    const piece = chunk.length > this.limit ? chunk.subarray(chunk.length - this.limit) : chunk;
    this.chunks.push(piece);
    this.kept += piece.length;
    while (this.kept > this.limit) {
      const head = this.chunks[0];
      if (!head) break;
      const over = this.kept - this.limit;
      if (head.length <= over) {
        this.chunks.shift();
        this.kept -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.kept -= over;
      }
    }
  }
  /** Offset, in the whole stream, of the first byte still kept. */
  get start(): number {
    return this.total - this.kept;
  }
  /** Up to `max` bytes from `offset`; before `start`, from `start`. Default: the last page. */
  read(offset: number | undefined, max: number): { offset: number; bytes: Buffer } {
    const from = Math.max(this.start, offset ?? this.total - max);
    const all = Buffer.concat(this.chunks);
    const at = Math.min(from - this.start, all.length);
    return { offset: this.start + at, bytes: all.subarray(at, at + max) };
  }
  /** Everything kept, with a note when earlier output was dropped. */
  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.start > 0
      ? `[first ${this.start} bytes dropped; the last ${this.kept} follow]\n${body}`
      : body;
  }
}

export interface CommandOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  durationMs: number;
}

/** One line an agent reads first: how the command ended. */
export function outcomeLine(outcome: CommandOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  if (outcome.timedOut) return `Timed out after ${seconds} s; its processes were stopped.`;
  if (outcome.stopped) return `Stopped after ${seconds} s.`;
  if (outcome.exitCode === null)
    return `Ended by ${outcome.signal ?? "a signal"} after ${seconds} s.`;
  return `Exit code ${outcome.exitCode} after ${seconds} s.`;
}
