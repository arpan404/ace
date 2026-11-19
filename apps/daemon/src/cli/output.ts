export { statusOutcome, treeOutcome } from "../work-outcome.ts";
import type { CliErrorCode, CliProblem } from "@ace/protocol/cli-output";
import { exitCodes } from "@ace/service/exit-codes";
export { exitCodes };
export type Outcome = keyof typeof exitCodes;
export function formatOutput(value: unknown, json: boolean): string {
  if (!json && typeof value === "string") return `${value}\n`;
  return `${JSON.stringify(value, null, json ? undefined : 2)}\n`;
}

/** What a failure can carry besides its sentence (ADR 0178 §4). */
export interface FailureDetail {
  readonly code?: CliErrorCode;
  /** The next step, one line: "See your threads with ace thread list." */
  readonly hint?: string;
  /** The argument or flag that was wrong. */
  readonly argument?: string;
  readonly problems?: readonly CliProblem[];
  /** A request ace opened for the person (a person-only market action). */
  readonly request?: string;
  /** The key to retry an uncertain mutation with. */
  readonly idempotencyKey?: string;
}

export class CliFailure extends Error {
  readonly outcome: Outcome;
  readonly evidence: unknown;
  readonly detail: FailureDetail;
  constructor(outcome: Outcome, message: string, evidence?: unknown, detail: FailureDetail = {}) {
    super(message);
    this.outcome = outcome;
    this.evidence = evidence;
    this.detail = detail;
  }
}

/** A command line that was wrong: exit 64, with the argument and the next step. */
export function usageFailure(message: string, detail: FailureDetail = {}): CliFailure {
  return new CliFailure("usage", message, undefined, { code: "bad_argument", ...detail });
}
