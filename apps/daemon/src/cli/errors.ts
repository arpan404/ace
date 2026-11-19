import type { CliError, CliErrorCode, CliOutcome } from "@ace/protocol/cli-output";
import { CliFailure, type Outcome } from "./output.ts";

/**
 * Any failure as a `CliError` and the sentence a person reads (ADR 0178 §4). Pure: it reads
 * the error's own fields and never imports the client, so the rescue path can use it.
 */

const outcomeCodes: Record<CliOutcome, CliErrorCode> = {
  ok: "failed",
  failed: "failed",
  "needs-human": "needs_human",
  timeout: "timeout",
  refused: "refused",
  uncertain: "uncertain",
  "address-in-use": "address_in_use",
  "lock-held": "lock_held",
  usage: "bad_argument",
  "newer-data": "newer_data",
  "incompatible-data": "incompatible_data",
};

const daemonDown = {
  error: "ace isn't running.",
  hint: "Start it with ace start, or open the app.",
};

export function toCliError(error: unknown, command?: string): CliError {
  const base = { ok: false as const, ...(command ? { command } : {}) };
  if (error instanceof CliFailure) {
    const { detail } = error;
    return {
      ...base,
      status: error.outcome,
      code: detail.code ?? outcomeCodes[error.outcome],
      error: error.message,
      ...(detail.hint ? { hint: detail.hint } : {}),
      ...(detail.argument ? { argument: detail.argument } : {}),
      ...(detail.problems ? { problems: [...detail.problems] } : {}),
      ...(detail.request ? { request: detail.request } : {}),
      ...(detail.idempotencyKey ? { retry: { idempotencyKey: detail.idempotencyKey } } : {}),
      ...(error.outcome === "uncertain" && !detail.hint && detail.idempotencyKey
        ? {
            hint: `Retry with --idempotency-key ${detail.idempotencyKey} to make sure it ran once.`,
          }
        : {}),
      ...(error.evidence !== undefined ? { admission: error.evidence } : {}),
    };
  }
  const exists = existingPath(error);
  if (exists !== undefined)
    return {
      ...base,
      status: "refused",
      code: "conflict",
      error: `${exists || "That file"} already exists, and ace doesn't overwrite it.`,
      hint: "Pass a path that doesn't exist yet.",
    };
  if (isDaemonDown(error))
    return { ...base, status: "refused", code: "daemon_down", ...daemonDown };
  const client = clientErrorCode(error);
  if (client !== undefined) {
    // As ADR 0072 had it: only a timeout or a refusal before dispatch is certain.
    const outcome: Outcome =
      client === "timeout"
        ? "timeout"
        : client === "auth" || client === "not_dispatched"
          ? "refused"
          : "uncertain";
    return {
      ...base,
      status: outcome,
      code: outcomeCodes[outcome],
      error: sentence(errorMessage(error)),
    };
  }
  if (isSchemaError(error))
    return {
      ...base,
      status: "usage",
      code: "bad_argument",
      error: schemaSentence(error),
      hint: command ? `See ace help ${command.replaceAll(".", " ")}.` : "See ace help.",
    };
  return {
    ...base,
    status: "failed",
    code: "internal",
    error: `Something went wrong in ace: ${sentence(errorMessage(error))}`,
    hint: "Run ace triage to report it.",
  };
}

/** `✕ No thread starting with t_9f2c.` then the next step, indented under it. */
export function humanError(error: CliError, paint: (text: string) => string = (t) => t): string {
  return `${paint("✕")} ${error.error}\n${error.hint ? `  ${error.hint}\n` : ""}${(
    error.problems ?? []
  )
    .map(
      (problem) =>
        `  ${problem.path ? `${problem.path}${problem.line ? `:${problem.line}` : ""}: ` : ""}${problem.message}\n`,
    )
    .join("")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentence(text: string): string {
  const trimmed = text.trim() || "it failed";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function clientErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "ClientError") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** A write that refused to replace a file: the path, or "" when the error doesn't say. */
function existingPath(error: unknown): string | undefined {
  if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") return undefined;
  const path = Reflect.get(error, "path");
  return typeof path === "string" ? path : "";
}

/** No endpoint file, or nothing listening on it: the daemon isn't up. */
function isDaemonDown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  if (code === "ECONNREFUSED") return true;
  return code === "ENOENT" && /daemon-(endpoint|token)/.test(error.message);
}

function isSchemaError(error: unknown): error is Error & { issues: unknown[] } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray(Reflect.get(error, "issues"))
  );
}

/** "THREAD must be …" rather than Zod's issue list. */
function schemaSentence(error: { issues: unknown[] }): string {
  const first = error.issues[0];
  const message =
    first && typeof first === "object" && typeof Reflect.get(first, "message") === "string"
      ? String(Reflect.get(first, "message"))
      : "an argument isn't in the form ace expects";
  return sentence(`An argument isn't in the form ace expects: ${message}`);
}
