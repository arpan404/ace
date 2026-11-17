import { z } from "zod";

/**
 * What the `ace` CLI prints and how it exits (ADR 0176 §3–§5). Schema only: the CLI builds
 * these values, and agents and scripts that call it parse them.
 */

/** Exit names; `exitCodeOf` gives each one's number. 64 is sysexits' EX_USAGE. */
export const CliOutcome = z.enum([
  "ok",
  "failed",
  "needs-human",
  "timeout",
  "refused",
  "uncertain",
  "address-in-use",
  "lock-held",
  "usage",
  "newer-data",
  "incompatible-data",
]);
export type CliOutcome = z.infer<typeof CliOutcome>;

export const cliExitCodes = {
  ok: 0,
  failed: 1,
  "needs-human": 2,
  timeout: 3,
  refused: 4,
  uncertain: 5,
  "address-in-use": 6,
  "lock-held": 7,
  usage: 64,
  "newer-data": 65,
  "incompatible-data": 66,
} as const satisfies Record<CliOutcome, number>;

/** Stable error codes an agent can branch on. New codes may be added; none is renamed. */
export const CliErrorCode = z.enum([
  // usage (64)
  "unknown_command",
  "unknown_flag",
  "missing_argument",
  "bad_argument",
  "too_many_arguments",
  "retired_command",
  /** A reference prefix matched more than one thing (a thread, a request). */
  "ambiguous",
  // refused (4)
  "refused",
  "not_found",
  "daemon_down",
  "turned_off",
  "busy",
  "forbidden",
  "conflict",
  "suspended",
  "quota",
  // needs-human (2)
  "needs_human",
  "signed_out",
  "reauth",
  "person_only",
  "confirm",
  // failed (1)
  "failed",
  "blocked",
  "check_failed",
  "internal",
  // the rest
  "timeout",
  "uncertain",
  "address_in_use",
  "lock_held",
  "newer_data",
  "incompatible_data",
]);
export type CliErrorCode = z.infer<typeof CliErrorCode>;

/** One problem a local check or the market found, as the sentence a publisher reads. */
export const CliProblem = z.object({
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
});
export type CliProblem = z.infer<typeof CliProblem>;

/**
 * A failed command's one JSON value with `--json`. `status`, `error` and `admission` keep ADR
 * 0072's names so callers that parsed them keep working.
 */
export const CliError = z.object({
  ok: z.literal(false),
  status: CliOutcome,
  code: CliErrorCode,
  error: z.string(),
  hint: z.string().optional(),
  command: z.string().optional(),
  argument: z.string().optional(),
  suggestion: z.string().optional(),
  retry: z.object({ idempotencyKey: z.string() }).optional(),
  request: z.string().optional(),
  admission: z.unknown().optional(),
  problems: z.array(CliProblem).optional(),
});
export type CliError = z.infer<typeof CliError>;

export const CliArgument = z.object({
  name: z.string(),
  summary: z.string(),
  required: z.boolean(),
  variadic: z.boolean(),
  stdin: z.boolean(),
});
export type CliArgument = z.infer<typeof CliArgument>;

export const CliFlag = z.object({
  name: z.string(),
  short: z.string().optional(),
  value: z.string().optional(),
  summary: z.string(),
  repeat: z.boolean(),
  choices: z.array(z.string()).optional(),
});
export type CliFlag = z.infer<typeof CliFlag>;

export const CliAlias = z.object({
  words: z.array(z.string()),
  /** The release the new spelling shipped in; absent for a permanent shortcut. */
  deprecatedSince: z.string().optional(),
});

export const CliCommand = z.object({
  id: z.string(),
  words: z.array(z.string()),
  summary: z.string(),
  description: z.string().optional(),
  group: z.string(),
  arguments: z.array(CliArgument),
  flags: z.array(CliFlag),
  examples: z.array(z.object({ command: z.string(), summary: z.string() })),
  aliases: z.array(CliAlias),
  output: z.string().optional(),
  mutates: z.boolean(),
  /** Works with the daemon down (ADR 0092). */
  offline: z.boolean(),
});
export type CliCommand = z.infer<typeof CliCommand>;

/** `ace help --json`: every visible command, the global flags and the help topics. */
export const CliCommandTree = z.object({
  version: z.string(),
  globalFlags: z.array(CliFlag),
  commands: z.array(CliCommand),
  topics: z.array(z.object({ name: z.string(), summary: z.string() })),
  exitCodes: z.array(z.object({ code: z.number().int(), name: CliOutcome, means: z.string() })),
});
export type CliCommandTree = z.infer<typeof CliCommandTree>;

/** `ace help COMMAND --json`. */
export const CliCommandHelp = CliCommand;

export const CliVersionOutput = z.object({ version: z.string() });
export const CliOkOutput = z.object({ ok: z.literal(true) }).loose();
