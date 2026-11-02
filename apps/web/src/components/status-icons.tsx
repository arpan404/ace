import {
  CheckCircleIcon,
  CircleDashedIcon,
  ClockCountdownIcon,
  GaugeIcon,
  HandPalmIcon,
  QuestionIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";
import type { RowStatusIconKind, RowStatusTone } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { WaitingCountMark } from "./waiting-count-mark.tsx";

/*
 * The thread-row status icons: one table from the state's icon (`rowStatusLook` in ui-core picks
 * it) to its Phosphor glyph and weight, and from its tone to its colour token
 * (`--row-status-*`, theme/tokens.ts). Rows, the one-line indicator and the hover card all draw
 * through `StatusIcon`. Nothing animates.
 */

const glyphs: Record<Exclude<RowStatusIconKind, "agents">, { icon: Icon; weight: IconWeight }> = {
  model: { icon: SlidersHorizontalIcon, weight: "fill" },
  approve: { icon: HandPalmIcon, weight: "fill" },
  question: { icon: QuestionIcon, weight: "fill" },
  failed: { icon: WarningCircleIcon, weight: "fill" },
  working: { icon: CircleDashedIcon, weight: "bold" },
  // Any other wait (the queue, a recovery to review): a countdown clock.
  waiting: { icon: ClockCountdownIcon, weight: "fill" },
  // Held at a usage limit: a gauge at its end, with no running time.
  limited: { icon: GaugeIcon, weight: "fill" },
  background: { icon: TerminalWindowIcon, weight: "fill" },
  done: { icon: CheckCircleIcon, weight: "fill" },
};

/** Each state's colour; a seen failure takes the quiet muted ink. */
const tones: Record<RowStatusTone, string> = {
  "needs-you": "text-(--row-status-needs-you)",
  failed: "text-(--row-status-failed)",
  working: "text-(--row-status-working)",
  waiting: "text-(--row-status-waiting)",
  background: "text-(--row-status-background)",
  finished: "text-(--row-status-finished)",
  idle: "text-muted-foreground",
};

/**
 * One status icon in its state's colour. Decorative: the row names its state in words for
 * assistive tech (and the count mark's number is in that name too).
 */
export function StatusIcon(props: {
  kind: RowStatusIconKind;
  tone: RowStatusTone;
  /** How many agents an `agents` mark waits on. */
  count?: number | undefined;
  size?: number | undefined;
}) {
  const size = props.size ?? 14;
  const entry = props.kind === "agents" ? undefined : glyphs[props.kind];
  return (
    <span
      aria-hidden
      data-icon={props.kind}
      data-tone={props.tone}
      className={cn("inline-flex shrink-0", tones[props.tone])}
    >
      {entry ? (
        <entry.icon size={size} weight={entry.weight} />
      ) : (
        <WaitingCountMark count={props.count} size={size} />
      )}
    </span>
  );
}
