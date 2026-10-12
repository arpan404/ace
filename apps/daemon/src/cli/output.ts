export { statusOutcome, treeOutcome } from "../work-outcome.ts";
export const exitCodes = {
  ok: 0,
  failed: 1,
  "needs-human": 2,
  timeout: 3,
  refused: 4,
  uncertain: 5,
} as const;
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
