import { formatCount } from "@ace/ui-core";
import { useState } from "react";
import { ClockCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { floatingControl, floatingMotion } from "./floating.ts";
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
  /** Leaving: it plays its exit and takes no input. */
  phase?: "enter" | "exit";
  onLive(): void;
}) {
  const headCount = useTurnHead(props.threadId)?.count;
  const leaving = props.phase === "exit";
  // Leaving, it keeps saying what it said: the window it described is already gone.
  const live = { turn: props.turn, reading: props.reading, count: headCount, failed: props.failed };
  const [shown, setShown] = useState(live);
  const changed =
    shown.turn !== live.turn ||
    shown.reading !== live.reading ||
    shown.count !== live.count ||
    shown.failed !== live.failed;
  if (!leaving && changed) setShown(live);
  const { turn, reading, count, failed } = leaving ? shown : live;
  const where =
    turn === undefined ? "Viewing earlier history" : `Jumped to turn ${formatCount(turn)}`;
  const at = reading ?? turn;
  const moved = at !== undefined && at !== turn;
  return (
    <div
      role={leaving ? undefined : "status"}
      aria-label={leaving ? undefined : "Jumped"}
      aria-hidden={leaving || undefined}
      inert={leaving}
      style={{ pointerEvents: leaving ? "none" : "auto" }}
      className={cn(
        floatingControl,
        floatingMotion(props.phase ?? "enter"),
        "gap-2 pr-1 pl-3 text-muted-foreground",
      )}
    >
      <ClockCounterClockwiseIcon aria-hidden size={14} className="shrink-0" />
      <span className="font-medium text-foreground">{where}</span>
      {at !== undefined && (
        <span className="tabular-nums">
          {moved ? `· at turn ${formatCount(at)}` : ""}
          {count !== undefined && count >= at ? ` of ${formatCount(count)}` : ""}
        </span>
      )}
      {failed && <span className="text-status-failed">{failed}</span>}
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
      className={cn(floatingControl, floatingMotion("enter"), "gap-2 pr-1 pl-3 text-status-failed")}
    >
      {props.message}
      <Button variant="ghost" size="sm" onClick={props.onDismiss}>
        Dismiss
      </Button>
    </p>
  );
}
