import type { ForgeCheckLog, ForgeCheckStep } from "@ace/protocol/forge-checks";

/*
 * A GitHub Actions job log as the PR panel reads it. Each runner line starts with an ISO
 * timestamp; workflow commands (`##[group]`, `##[error]`...) mark groups and errors. Pure.
 */

const stamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;
const command = /^##\[(group|endgroup|error|warning|notice|debug|section|command)\]/;
// Colour and cursor escapes the runner passes through from tools.
// oxlint-disable-next-line no-control-regex -- the escape character is what this strips
const escapes = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const maxErrors = 1_000;

export interface JobStepFacts {
  number: number;
  name: string;
  status: ForgeCheckStep["status"];
  /** When the step started, as GitHub reports it (whole seconds). */
  startedAt: number | null;
}

/** Seconds-resolution time of an ISO stamp, so a step's start compares with its lines. */
function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1_000);
}

/**
 * The log's lines without timestamps and markers, its error lines, where each step starts and
 * where the panel opens: the first failing step, else the first error.
 */
export function readJobLog(
  raw: string,
  truncated: boolean,
  steps: readonly JobStepFacts[],
): { log: ForgeCheckLog; steps: ForgeCheckStep[] } {
  const lines: string[] = [];
  const errors: number[] = [];
  const times: (number | undefined)[] = [];
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  let last: number | undefined;
  for (const original of source.split("\n")) {
    let line = original.endsWith("\r") ? original.slice(0, -1) : original;
    const time = stamp.exec(line);
    if (time?.[1]) {
      last = seconds(time[1]);
      line = line.slice(time[0].length);
    }
    line = line.replace(escapes, "");
    const marker = command.exec(line);
    if (marker?.[1] === "endgroup") continue;
    if (marker) line = line.slice(marker[0].length);
    if (marker?.[1] === "error" && errors.length < maxErrors) errors.push(lines.length);
    lines.push(line);
    times.push(last);
  }
  // A log that ends with a newline has no line after it.
  if (lines.length && lines.at(-1) === "") {
    lines.pop();
    times.pop();
  }
  const starts = steps.map((step): ForgeCheckStep => {
    const at = step.startedAt;
    const index = at === null ? -1 : times.findIndex((time) => time !== undefined && time >= at);
    return {
      number: step.number,
      name: step.name,
      status: step.status,
      line: index < 0 ? null : index,
    };
  });
  const failing = starts.find((step) => step.status === "failure" && step.line !== null);
  return {
    log: {
      text: lines.join("\n"),
      truncated,
      errors,
      focus: failing?.line ?? errors[0] ?? null,
    },
    steps: starts,
  };
}
