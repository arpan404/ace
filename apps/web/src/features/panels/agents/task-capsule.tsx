import type { ReactNode } from "react";
import type { Tone } from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import type { GlyphState } from "@/components/status-glyph-state.ts";
import { plainRow } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";

/*
 * The Summary tab's task capsules: one borderless row per agent or background command, with an
 * 18px status glyph, the name, muted meta and, only when the person is needed, a small badge.
 * ace's own component, drawn in its tokens.
 */

export type CapsuleState =
  | "working"
  | "waiting"
  | "background"
  | "needs-you"
  | "done"
  | "failed"
  | "stopped";

/** A capsule's outer shell: a plain list row, a hover fill and nothing at rest. */
export const capsule = plainRow;

const tones: Record<CapsuleState, Tone> = {
  working: "working",
  waiting: "waiting",
  background: "background",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  stopped: "idle",
};

const glyphs: Record<CapsuleState, GlyphState> = {
  working: "working",
  // Its own turn is over while its subagents or commands still run.
  waiting: "subagents",
  background: "background",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/**
 * The status glyph (status-glyph.tsx): a working ring that rocks open, holding how many of its
 * own still run, and holds still while the facts are stale; arcs that ratchet while it waits on
 * its own; a check when it finished; a cross when it failed; a solid "!" while it needs the
 * person.
 */
export function CapsuleGlyph(props: { state: CapsuleState; count?: number | undefined }) {
  const fresh = useLiveConnection().fresh;
  return (
    <StatusGlyph
      state={glyphs[props.state]}
      tone={tones[props.state]}
      size={18}
      still={!fresh}
      className={cn(props.count && "text-2xs leading-none font-semibold tabular-nums")}
    >
      {props.count ? <span className="relative text-(--tone-text)">{props.count}</span> : null}
    </StatusGlyph>
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
