import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useClient } from "@ace/client-react";
import type { Item, RawPayload } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";

/** While a step runs, its payloads are read again at most this often. */
export const runningRefreshMs = 1500;

interface Read {
  /** Every payload read so far of one version, oldest first. */
  raw: readonly RawPayload[];
  /** The version they are of, and where its next page starts (undefined once all are read). */
  revision: string | undefined;
  next: number | undefined;
  /** Whether a first page has arrived. */
  started: boolean;
  state: "idle" | "loading" | "failed";
}

const unread: Read = { raw: [], revision: undefined, next: 0, started: false, state: "idle" };

/** Whether a step may still change: its payloads so far may not be its last. */
function stillRunning(item: Item): boolean {
  if (item.type === "tool_call")
    return ["pending", "awaiting_approval", "running"].includes(item.call.status);
  return !item.complete;
}

/**
 * A step's raw payloads the daemon left out of the transcript (`rawOmitted`, hello trim
 * `raw-on-demand`): read with `item.raw` the first time the disclosure opens, a page at a time
 * within one version of them.
 *
 * At most one read is in flight. A change to the step while one is (even the first) marks it
 * stale, and exactly one read from the start follows when it ends: at once if the step has
 * finished, else after `runningRefreshMs`. A step that updates fast over a slow link is read at
 * a bounded rate, and its final payloads always show.
 */
export function OmittedRaw(props: { threadId: string; item: Item }) {
  const client = useClient();
  const [read, setRead] = useState<Read>(unread);
  const [open, setOpen] = useState(false);
  /** The step as last rendered, for a read that ends to compare with. */
  const latest = useRef(props.item);
  const busy = useRef(false);
  /** The step changed since the read in flight began. */
  const stale = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ask = (from: number, revision: string | undefined) =>
    client.request({
      type: "item.raw",
      threadId: props.threadId,
      itemId: props.item.id,
      from,
      ...(revision === undefined ? {} : { revision }),
    });
  /** One page from `from` of `revision`; a version that changed is read again from its start. */
  const fetchPage = async (from: number, revision: string | undefined) => {
    const reply = await ask(from, revision);
    return reply.changed ? ask(0, undefined) : reply;
  };
  /** Read a page; when it ends, follow with one read from the start if the step moved on. */
  const start = (from: number, revision: string | undefined) => {
    busy.current = true;
    stale.current = false;
    const began = latest.current;
    const done = () => {
      busy.current = false;
      if (stale.current || latest.current !== began) followUp();
    };
    fetchPage(from, revision).then(
      (reply) => {
        setRead((current) => ({
          raw: reply.from === 0 ? reply.raw : [...current.raw, ...reply.raw],
          revision: reply.revision,
          next: reply.next,
          started: true,
          state: "idle",
        }));
        done();
      },
      () => {
        setRead((current) => ({ ...current, state: "failed" }));
        done();
      },
    );
  };
  /** One read from the start: after the one in flight, and spaced while the step runs. */
  const followUp = () => {
    if (busy.current) {
      stale.current = true;
      return;
    }
    if (!stillRunning(latest.current)) {
      clearTimeout(timer.current);
      timer.current = undefined;
      start(0, undefined);
      return;
    }
    timer.current ??= setTimeout(() => {
      timer.current = undefined;
      if (busy.current) stale.current = true;
      else start(0, undefined);
    }, runningRefreshMs);
  };
  const load = (from: number, revision: string | undefined) => {
    setRead((current) => ({ ...current, state: "loading" }));
    start(from, revision);
  };
  // The step changed while its payloads are open: read them again (what is shown stays until
  // the new read arrives).
  useEffect(() => {
    if (latest.current === props.item) return;
    latest.current = props.item;
    if (busy.current) stale.current = true;
    else if (open && read.started) followUp();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a new item starts a read
  }, [props.item]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const more = read.next !== undefined && read.state !== "loading";
  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !read.started && !busy.current) load(0, undefined);
      }}
    >
      <CollapsibleTrigger className="self-start text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline">
        Raw
      </CollapsibleTrigger>
      <CollapsibleContent>
        {read.started && stillRunning(props.item) && (
          <p className="text-xs text-subtle-foreground">Still running: these may not be final.</p>
        )}
        {read.started && (
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(read.raw, null, 2)}
          </pre>
        )}
        {read.state === "loading" && <Spinner />}
        {read.state === "failed" && (
          <p role="alert" className="text-xs text-muted-foreground">
            Couldn't read the raw payloads.
          </p>
        )}
        {more && (read.started || read.state === "failed") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => load(read.next ?? 0, read.started ? read.revision : undefined)}
          >
            {read.state === "failed" ? "Retry" : "Show more"}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
