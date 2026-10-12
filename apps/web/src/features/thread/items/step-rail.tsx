import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { createContext, use, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * Steps shown on a thin rail: an opened group, an opened "Worked for". Each finished step sits on
 * the rail with a small check, a failed one with a small cross, and the step in flight with a
 * quiet dot (its words shimmer). Rows learn they are on a rail from context, so the same rows
 * draw in the plain flow and on the rail.
 */

const OnRail = createContext(false);

export function StepRail(props: { children: ReactNode; label: string; id?: string | undefined }) {
  return (
    <OnRail value>
      <ul
        id={props.id}
        aria-label={props.label}
        className="fx-rise-in ml-1.5 flex flex-col border-l border-border pl-4.5"
      >
        {props.children}
      </ul>
    </OnRail>
  );
}

export type RailState = "done" | "running" | "failed";

/** The step's mark on the rail, when it is on one. */
export function RailMark(props: { state: RailState }) {
  if (!use(OnRail)) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-2.5 -left-6 grid size-3 place-items-center rounded-full bg-background",
        props.state === "failed" ? "text-status-failed" : "text-subtle-foreground",
      )}
    >
      {props.state === "done" ? (
        <CheckIcon size={10} weight="bold" />
      ) : props.state === "failed" ? (
        <XIcon size={10} weight="bold" />
      ) : (
        <span className="size-1.5 rounded-full bg-muted-foreground" />
      )}
    </span>
  );
}
