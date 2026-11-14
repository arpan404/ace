import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useClient } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { useEffect, useReducer, useRef } from "react";
import { canReadMore, initialRawReads, stepRawReads, type RawInput } from "./raw-reads.ts";

/** While a step runs, its payloads are read again at most this often. */
export const runningRefreshMs = 1500;

/** Whether a step may still change: its payloads so far may not be its last. */
function stillRunning(item: Item): boolean {
  if (item.type === "tool_call")
    return ["pending", "awaiting_approval", "running"].includes(item.call.status);
  return !item.complete;
}

/**
 * The reads of one step's raw payloads (`raw-reads.ts` decides them): sends the read the
 * machine names, runs the refresh timer it asks for, and tells it when the step changes. Once
 * unmounted, no reply sets state, starts a timer or sends a read. Keyed by item at the call
 * site, so another step starts afresh.
 */
function useRawReads(threadId: string, item: Item) {
  const client = useClient();
  const [state, dispatch] = useReducer(stepRawReads, stillRunning(item), initialRawReads);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const send = (input: RawInput) => {
    if (alive.current) dispatch(input);
  };
  // The step changed: tell the machine (it decides whether and when to read again).
  const shown = useRef(item);
  useEffect(() => {
    if (shown.current === item) return;
    shown.current = item;
    dispatch({ type: "changed", running: stillRunning(item) });
  }, [item]);
  const read = state.read;
  const itemId = item.id;
  useEffect(() => {
    if (!read) return;
    client
      .request({
        type: "item.raw",
        threadId,
        itemId,
        from: read.from,
        ...(read.revision === undefined ? {} : { revision: read.revision }),
      })
      .then(
        (reply) => send({ type: "reply", id: read.id, reply }),
        () => send({ type: "error", id: read.id }),
      );
    // A read is sent once, when the machine names it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the read's id
  }, [read?.id]);
  const waiting = state.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => send({ type: "timer" }), runningRefreshMs);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `send` only checks the ref
  }, [waiting]);
  return { state, dispatch };
}

/**
 * A step's raw payloads the daemon left out of the transcript (`rawOmitted`, hello trim
 * `raw-on-demand`), read with `item.raw` when the disclosure opens: one read at a time, a page
 * per "Show more", read again from the start when the step changes (at most every 1.5 s while
 * it runs). A refresh replaces the pages shown when it lands; "Show more" then reads on.
 */
export function OmittedRaw(props: { threadId: string; item: Item }) {
  const { state, dispatch } = useRawReads(props.threadId, props.item);
  const out = state.phase === "reading" || state.phase === "stale";
  return (
    <Collapsible onOpenChange={(open) => dispatch({ type: open ? "open" : "close" })}>
      <CollapsibleTrigger className="self-start text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline">
        Raw
      </CollapsibleTrigger>
      <CollapsibleContent>
        {state.started && state.running && (
          <p className="text-xs text-subtle-foreground">Still running: these may not be final.</p>
        )}
        {state.started && (
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(state.raw, null, 2)}
          </pre>
        )}
        {out && <Spinner />}
        {state.failed && !out && (
          <>
            <p role="alert" className="text-xs text-muted-foreground">
              Couldn't read the raw payloads.
            </p>
            <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "retry" })}>
              Retry
            </Button>
          </>
        )}
        {!state.failed && state.started && state.next !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canReadMore(state)}
            onClick={() => dispatch({ type: "more" })}
          >
            Show more
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
