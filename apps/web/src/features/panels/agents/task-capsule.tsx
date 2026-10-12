import { CheckIcon, ExclamationMarkIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * The Summary tab's task capsules: one rounded row per agent or background command, with an
 * 18px status glyph, the name, muted meta, a small status badge and a chevron. ace's own
 * component, drawn in its tokens.
 */

export type CapsuleState = "working" | "waiting" | "needs-you" | "done" | "failed" | "stopped";

/** A capsule's outer shell: a quiet raised fill, a hairline edge, rounded like a pill row. */
export const capsule =
  "rounded-[10px] border border-border/70 bg-surface-1 transition-colors duration-(--motion-fast) hover:bg-accent";

const tones: Record<CapsuleState, string> = {
  working: "working",
  waiting: "waiting",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  stopped: "idle",
};

/**
 * The status glyph: a ring while it works, holding how many of its own still run; a check on
 * the done tone when it finished; a cross when it failed; "!" while it needs the person. The
 * ring stays still: working states don't animate (the motion policy).
 */
export function CapsuleGlyph(props: { state: CapsuleState; count?: number | undefined }) {
  const tone = tones[props.state];
  if (props.state === "working" || props.state === "waiting")
    return (
      <span
        aria-hidden
        data-tone={tone}
        className="relative grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-(--tone)/25 border-t-(--tone) text-[10px] leading-none font-semibold text-(--tone-text) tabular-nums"
      >
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
      className="grid size-[18px] shrink-0 place-items-center rounded-full bg-(--tone) text-background"
    >
      {Glyph ? (
        <Glyph size={11} weight="bold" />
      ) : (
        <span className="size-1.5 rounded-[1px] bg-current" />
      )}
    </span>
  );
}

/** A small status word on its tone's tint: "Completed", "Failed", "Needs you". */
export function CapsuleBadge(props: { state: CapsuleState; children: ReactNode }) {
  return (
    <span
      data-tone={tones[props.state]}
      className="shrink-0 rounded-sm bg-(--tone)/12 px-1.5 py-px text-[11px] leading-4 font-medium text-(--tone-text)"
    >
      {props.children}
    </span>
  );
}

/** The words a capsule's badge shows for a state; a working capsule shows none (its ring says it). */
export const badgeWords: Partial<Record<CapsuleState, string>> = {
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
