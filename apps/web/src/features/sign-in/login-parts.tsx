import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import type { LoginRefusal } from "./login-controller.ts";

/*
 * The pieces every step of the sign-in dialog is built from: a centred title and line, the
 * live "waiting" line, a column of full-width actions, and the words for a refused request.
 */

/** A step's primary action, focused as the step appears, so the keyboard never lands on nothing. */
export function useFocusOnShow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** One step of the dialog. Each arrives with a short rise; `key` it by step to replay that. */
export function Step(props: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("fx-rise-in flex flex-col gap-4", props.className)}>{props.children}</div>
  );
}

/** The step in words: what is happening now, and one quiet line under it. */
export function StepTitle(props: { title: string; line?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <p className="text-md font-medium text-balance text-foreground">{props.title}</p>
      {props.line && (
        <p className="max-w-[44ch] text-ui text-balance text-muted-foreground">{props.line}</p>
      )}
    </div>
  );
}

/** "Waiting for you to finish in your browser", shimmering while it waits. */
export function Waiting(props: { text: string }) {
  return (
    <p className="flex items-center justify-center gap-2 text-sm">
      <span aria-hidden className="relative grid size-2 place-items-center">
        <span className="fx-ring absolute inset-0 rounded-full bg-status-working" />
        <span className="size-1.5 rounded-full bg-status-working" />
      </span>
      <span className="shimmer">{props.text}</span>
    </p>
  );
}

/** The step's buttons, stacked full width: the primary one first. */
export function Actions(props: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 pt-1 *:w-full">{props.children}</div>;
}

/** A request the daemon turned down, in words: what happened and what to do. */
export const refusals: Record<LoginRefusal, (name: string) => [string, string | undefined]> = {
  forbidden: () => [
    "This device can't sign in to providers",
    "Pair it with full access from Settings → Remote devices on the computer running ace.",
  ],
  busy: (name) => [
    `${name} is already signing in`,
    "Finish or cancel that sign-in first, then try again.",
  ],
  unavailable: (name) => [`ace can't run ${name}'s sign-in here`, undefined],
  not_found: () => ["That sign-in has ended", "Start it again."],
  invalid_input: () => [`That answer didn't go through`, "Try again."],
  offline: () => [
    "ace can't reach the computer running it",
    "Check the connection, then try again.",
  ],
};
