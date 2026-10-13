import { CheckIcon, ExclamationMarkIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { plainRow } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";

/*
 * The Summary tab's task capsules: one borderless row per agent or background command, with an
 * 18px status glyph, the name, muted meta and, only when the person is needed, a small badge.
 * ace's own component, drawn in its tokens.
 */

export type CapsuleState = "working" | "waiting" | "needs-you" | "done" | "failed" | "stopped";

/** A capsule's outer shell: a plain list row, a hover fill and nothing at rest. */
export const capsule = plainRow;

const tones: Record<CapsuleState, string> = {
  working: "working",
  waiting: "waiting",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  stopped: "idle",
};

/**
 * The status glyph: a ring while it works, turning slowly (the live-activity motion, still
 * under reduced motion or while the facts are stale) and holding how many of its own still run;
 * a still ring while it waits; a check when it finished; a cross when it failed; "!" while it
 * needs the person.
 */
export function CapsuleGlyph(props: { state: CapsuleState; count?: number | undefined }) {
  const fresh = useLiveConnection().fresh;
  const tone = tones[props.state];
  if (props.state === "working" || props.state === "waiting")
    return (
      <span
        aria-hidden
        data-tone={tone}
        className="relative grid size-[18px] shrink-0 place-items-center text-2xs leading-none font-semibold text-(--tone-text) tabular-nums"
      >
        <span
          className={cn(
            "absolute inset-0 rounded-full border-[1.5px] border-(--tone)/25 border-t-(--tone)",
            props.state === "working" && fresh && "fx-spin-slow",
          )}
        />
        {props.count ? props.count : null}
      </span>
    );
  const Glyph =
    props.state === "done"
      ? CheckIcon
      : props.state === "needs-you"
        ? ExclamationMarkIcon
        : props.state === "failed"
          ? XIcon
          : undefined;
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-full",
        props.state === "done" ? "text-(--tone-text)" : "bg-(--tone) text-background",
      )}
    >
      {Glyph ? <Glyph size={11} weight="bold" /> : <span className="size-1.5 bg-current" />}
    </span>
  );
}

/** "Needs you" on its tone's tint: the one status a row raises above its muted meta. */
export function CapsuleBadge(props: { state: CapsuleState; children: ReactNode }) {
  return (
    <span
      data-tone={tones[props.state]}
      className="shrink-0 rounded-sm bg-(--tone)/12 px-1.5 py-px text-2xs leading-4 font-medium text-(--tone-text)"
    >
      {props.children}
    </span>
  );
}

/** The words a settled capsule's meta says; a working capsule says what it is doing instead. */
export const stateWords: Partial<Record<CapsuleState, string>> = {
  done: "Completed",
  failed: "Failed",
  "needs-you": "Needs you",
  stopped: "Stopped",
};

/** Muted meta beside a capsule's name: "Reading cache.ts", "6m". */
export function CapsuleMeta(props: { children: ReactNode; className?: string | undefined }) {
  return (
    <span className={cn("min-w-0 truncate text-xs text-muted-foreground", props.className)}>
      {props.children}
    </span>
  );
}
