import type { DeviceProblem } from "./use-devices.ts";

/** A refusal or failure in one line: what happened, then what to do. */
export function Problem(props: { problem: DeviceProblem; className?: string }) {
  return (
    <p role="alert" className={props.className ?? "text-sm text-muted-foreground"}>
      <span className="text-foreground">{props.problem.message}</span>
      {props.problem.hint && ` ${props.problem.hint}`}
    </p>
  );
}
