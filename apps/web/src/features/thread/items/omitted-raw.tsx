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
 * within one version of them. When the step changes while open they are read again from the
 * start, so a running step's view ends on its final payloads.
 */
export function OmittedRaw(props: { threadId: string; item: Item }) {
  const client = useClient();
  const [read, setRead] = useState<Read>(unread);
  const [open, setOpen] = useState(false);
  // Replies to a read that a newer one replaced are dropped.
  const generation = useRef(0);
  const ask = (start: number, version: string | undefined) =>
    client.request({
      type: "item.raw",
      threadId: props.threadId,
      itemId: props.item.id,
      from: start,
      ...(version === undefined ? {} : { revision: version }),
    });
  /** One page from `from` of `revision`; a version that changed is read again from its start. */
  const fetchPage = async (from: number, revision: string | undefined) => {
    const reply = await ask(from, revision);
    return reply.changed ? ask(0, undefined) : reply;
  };
  /** Show a page that arrived, after what is shown unless it starts the payloads again. */
  const show = (reply: Awaited<ReturnType<typeof fetchPage>>) =>
    setRead((current) => ({
      raw: reply.from === 0 ? reply.raw : [...current.raw, ...reply.raw],
      revision: reply.revision,
      next: reply.next,
      started: true,
      state: "idle",
    }));
  const failed = () => setRead((current) => ({ ...current, state: "failed" }));
  /** Read the page from `from` and show it, unless a newer read replaced this one. */
  const pageIn = (from: number, revision: string | undefined) => {
    const mine = ++generation.current;
    return fetchPage(from, revision).then(
      (reply) => {
        if (mine === generation.current) show(reply);
      },
      () => {
        if (mine === generation.current) failed();
      },
    );
  };
  const load = (from: number, revision: string | undefined) => {
    setRead((current) => ({ ...current, state: "loading" }));
    void pageIn(from, revision);
  };
  // The step changed while its payloads are on screen: read them again (what is shown stays
  // until the new read arrives).
  const shown = useRef(props.item);
  useEffect(() => {
    if (shown.current === props.item) return;
    shown.current = props.item;
    if (!open || !read.started) return;
    const mine = ++generation.current;
    fetchPage(0, undefined).then(
      (reply) => {
        if (mine === generation.current) show(reply);
      },
      () => {
        if (mine === generation.current) failed();
      },
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a new item starts a read
  }, [props.item]);
  const more = read.next !== undefined && read.state !== "loading";
  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !read.started && read.state !== "loading") load(0, undefined);
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
