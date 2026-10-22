import {
  verifySettled,
  type VerifyFailure,
  type VerifyRun,
  type VerifyState,
  type VerifyStep,
  type VerifyTarget,
  type WorkspaceId,
} from "@ace/protocol";

/*
 * The pure life of a Verify run (ADR 0094): which steps it plans, and how each fact the runner
 * reports changes it. No I/O; every change bumps the revision so clients keep the newest copy.
 */

export type StepKind = VerifyStep["kind"];
export type SettledState = Exclude<VerifyState, "queued" | "running" | "merging">;

export type VerifyEvent =
  | { type: "start" }
  | { type: "step"; kind: StepKind; pr?: number; state: "running" | "done" | "failed" | "skipped" }
  | { type: "base"; branch: string; sha: string }
  | { type: "exit"; code: number | null }
  | { type: "merging" }
  | { type: "merged"; pr: number }
  | { type: "settle"; state: SettledState; failure?: VerifyFailure };

/** The steps a target runs, in order. */
export function planSteps(target: VerifyTarget): VerifyStep[] {
  if (target.kind === "check")
    return [
      { kind: "fetch", state: "pending" },
      { kind: "setup", state: "pending" },
      { kind: "check", state: "pending" },
    ];
  const numbers = target.prs.map((entry) => entry.pr.number);
  return [
    { kind: "fetch", state: "pending" },
    ...numbers.map((pr) => ({ kind: "combine" as const, pr, state: "pending" as const })),
    { kind: "setup", state: "pending" },
    { kind: "check", state: "pending" },
    ...numbers.map((pr) => ({ kind: "merge" as const, pr, state: "pending" as const })),
  ];
}

export function newRun(input: {
  id: string;
  workspaceId: WorkspaceId;
  target: VerifyTarget;
  command: string;
  at: number;
}): VerifyRun {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    target: input.target,
    state: "queued",
    command: input.command,
    steps: planSteps(input.target),
    createdAt: input.at,
    merged: [],
    revision: 0,
  };
}

export function isSettled(run: Pick<VerifyRun, "state">): boolean {
  return verifySettled.includes(run.state);
}

/** Cancel stops a run only before any GitHub merge began. */
export function canCancel(run: Pick<VerifyRun, "state">): boolean {
  return run.state === "queued" || run.state === "running";
}

/** The run after `event`; a settled run never changes again. */
export function applyVerify(run: VerifyRun, event: VerifyEvent, at: number): VerifyRun {
  if (isSettled(run)) return run;
  const next = { ...run, revision: run.revision + 1 };
  switch (event.type) {
    case "start":
      return { ...next, state: "running", startedAt: at };
    case "step":
      return { ...next, steps: run.steps.map((step) => stepped(step, event, at)) };
    case "base":
      return { ...next, base: { branch: event.branch, sha: event.sha } };
    case "exit":
      return { ...next, exitCode: event.code };
    case "merging":
      return { ...next, state: "merging" };
    case "merged":
      return run.merged.includes(event.pr) ? run : { ...next, merged: [...run.merged, event.pr] };
    case "settle":
      return {
        ...next,
        state: event.state,
        endedAt: at,
        steps: run.steps.map((step) => closed(step, at)),
        ...(event.failure ? { failure: event.failure } : {}),
      };
  }
}

function stepped(
  step: VerifyStep,
  event: Extract<VerifyEvent, { type: "step" }>,
  at: number,
): VerifyStep {
  if (step.kind !== event.kind || step.pr !== event.pr) return step;
  if (event.state === "running") return { ...step, state: "running", startedAt: at };
  return { ...step, state: event.state, endedAt: at };
}

/** At settling, a step still running was cut short and one never reached was skipped. */
function closed(step: VerifyStep, at: number): VerifyStep {
  if (step.state === "running") return { ...step, state: "failed", endedAt: at };
  if (step.state === "pending") return { ...step, state: "skipped" };
  return step;
}

/** What the person asked for, for messages: `#12`, `#12 and #13`, `#12, #13 and #14`. */
export function prList(numbers: readonly number[]): string {
  const names = numbers.map((number) => `#${number}`);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Messages fit the protocol's 512 characters. */
export function failure(
  code: VerifyFailure["code"],
  message: string,
  extra: { pr?: number; with?: number } = {},
): VerifyFailure {
  return {
    code,
    message: message.length > 512 ? `${message.slice(0, 511)}…` : message,
    ...(extra.pr === undefined ? {} : { pr: extra.pr }),
    ...(extra.with === undefined ? {} : { with: extra.with }),
  };
}
