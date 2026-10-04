import { formatCount } from "@ace/ui-core";
import { ClockCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTurnHead } from "./turn-index.ts";

/*
 * What a jumped transcript says about itself: where the reader is ("Jumped to turn 128 of
 * 2,000") and that newer history is not loaded after the window (the gap). Loaded after first
 * paint: only a jump shows them.
 */

/** The context bar over a jumped transcript: where the jump landed and where the reader is. */
export function JumpBar(props: {
  turn: number | undefined;
  /** The turn at the top of the view, once the reader has moved on from the jump's. */
  reading: number | undefined;
  threadId: string;
  failed: string | undefined;
  onLive(): void;
}) {
  const count = useTurnHead(props.threadId)?.count;
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
          {count !== undefined && count >= at ? ` of ${formatCount(count)}` : ""}
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
  threadId: string;
  /** The window's last item's turn, when known. */
  lastTurn: number | undefined;
  loading: boolean;
  onNewer(): void;
  onLive(): void;
}) {
  const count = useTurnHead(props.threadId)?.count;
  const newerTurns =
    count === undefined || props.lastTurn === undefined ? undefined : count - props.lastTurn;
  const label =
    newerTurns === undefined
      ? "Newer history isn't loaded"
      : newerTurns <= 0
        ? "The rest of this turn isn't loaded"
        : `${formatCount(newerTurns)} newer ${newerTurns === 1 ? "turn" : "turns"} until live`;
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

/** A jump that couldn't load, said over the live transcript it left in place. */
export function JumpFailed(props: { message: string; onDismiss(): void }) {
  return (
    <p
      role="alert"
      style={{ pointerEvents: "auto" }}
      className="glass flex h-8 items-center gap-2 rounded-full pr-1 pl-3 text-sm text-status-failed"
    >
      {props.message}
      <Button variant="ghost" size="sm" onClick={props.onDismiss}>
        Dismiss
      </Button>
    </p>
  );
}
