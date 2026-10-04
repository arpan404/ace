import { formatCount } from "@ace/ui-core";
import { ArrowDownIcon, ClockCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

/*
 * What a jumped transcript says about itself: where the reader is ("Jumped to turn 128 of
 * 2,000"), that newer history is not loaded after the window (the gap), and the way back to
 * the live end with how much arrived meanwhile.
 */

/** The context bar over a jumped transcript: where the jump landed and where the reader is. */
export function JumpBar(props: {
  turn: number | undefined;
  /** The turn at the top of the view, once the reader has moved on from the jump's. */
  reading: number | undefined;
  count: number | undefined;
  failed: string | undefined;
  onLive(): void;
}) {
  const where =
    props.turn === undefined
      ? "Viewing earlier history"
      : `Jumped to turn ${formatCount(props.turn)}`;
  const at = props.reading ?? props.turn;
  const moved = at !== undefined && at !== props.turn;
  return (
    <div
      role="status"
      aria-label="Jumped"
      style={{ pointerEvents: "auto" }}
      className="glass fx-rise-in flex h-8 items-center gap-2 rounded-full pr-1 pl-3 text-sm text-muted-foreground shadow-[var(--glass-shadow)]"
    >
      <ClockCounterClockwiseIcon aria-hidden size={14} className="shrink-0" />
      <span className="font-medium text-foreground">{where}</span>
      {at !== undefined && (
        <span className="tabular-nums">
          {moved ? `· at turn ${formatCount(at)}` : ""}
          {props.count !== undefined && props.count >= at ? ` of ${formatCount(props.count)}` : ""}
        </span>
      )}
      {props.failed && <span className="text-status-failed">{props.failed}</span>}
      <IconButton icon={XIcon} label="Back to live" size="sm" onClick={props.onLive} />
    </div>
  );
}

/**
 * The window's newer edge: what lies between it and the live end, loaded on as the reader
 * scrolls (or at once with Jump to live). Never a hole the list pretends isn't there.
 */
export function GapRow(props: {
  /** Turns after the window's last one, when the index says. */
  newerTurns: number | undefined;
  loading: boolean;
  onNewer(): void;
  onLive(): void;
}) {
  const label =
    props.newerTurns === undefined
      ? "Newer history isn't loaded"
      : props.newerTurns <= 0
        ? "The rest of this turn isn't loaded"
        : `${formatCount(props.newerTurns)} newer ${props.newerTurns === 1 ? "turn" : "turns"} until live`;
  return (
    <div
      role="group"
      aria-label="Gap to live"
      className="flex flex-col items-center gap-3 pt-2 pb-4"
    >
      <Marker variant="separator" className="text-xs text-subtle-foreground">
        <MarkerContent>{label}</MarkerContent>
      </Marker>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={props.loading} onClick={props.onNewer}>
          {props.loading && <Spinner />}
          Load newer
        </Button>
        <Button size="sm" onClick={props.onLive}>
          Jump to live
        </Button>
      </div>
    </div>
  );
}

/**
 * Back to the live end. It says how many items arrived since the reader left it, and that
 * following is paused while the agent works.
 */
export function LivePill(props: {
  newItems: number;
  /** More arrived than the live window holds. */
  more: boolean;
  paused: boolean;
  onClick(): void;
}) {
  const count = props.newItems ? `${formatCount(props.newItems)}${props.more ? "+" : ""} new` : "";
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={count ? `Jump to live, ${count}` : "Jump to live"}
      className="fx-rise-in glass absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground"
    >
      <ArrowDownIcon aria-hidden size={14} />
      {props.paused && (
        <span className="font-normal text-subtle-foreground">Following paused ·</span>
      )}
      Jump to live
      {count && (
        <span className="rounded-full bg-[color-mix(in_oklab,var(--ring)_22%,transparent)] px-1.5 text-xs tabular-nums text-foreground">
          {count}
        </span>
      )}
    </button>
  );
}
