import { formatCount } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { floatingControl, floatingMotion } from "./floating.ts";
import { useTurnHead } from "./turn-index.ts";

/*
 * What a jumped transcript says about itself: the gap between the window's
 * newer edge and the live end. There is deliberately no top overlay bar:
 * older history is one continuous list, and the live pill alone offers the
 * way back to the live end. Loaded after first paint: only a jump shows them.
 */

/**
 * The window's newer edge: what lies between it and the live end, loaded on as the reader
 * scrolls (or at once with Scroll to end). Never a hole the list pretends isn't there.
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
          Scroll to end
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
