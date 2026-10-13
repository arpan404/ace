export { statusOutcome, treeOutcome } from "../work-outcome.ts";
import { exitCodes } from "@ace/service/exit-codes";
export { exitCodes };
export type Outcome = keyof typeof exitCodes;
export function formatOutput(value: unknown, json: boolean): string {
  if (!json && typeof value === "string") return `${value}\n`;
  return `${JSON.stringify(value, null, json ? undefined : 2)}\n`;
}
export class CliFailure extends Error {
  readonly outcome: Outcome;
  readonly evidence: unknown;
  constructor(outcome: Outcome, message: string, evidence?: unknown) {
    super(message);
    this.outcome = outcome;
    this.evidence = evidence;
  }
}
