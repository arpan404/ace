import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useClient } from "@ace/client-react";
import type { RawPayload } from "@ace/protocol";
import { useState } from "react";

interface Read {
  /** Every payload read so far, oldest first. */
  raw: readonly RawPayload[];
  /** Where the next page starts, or undefined once all are read. */
  next: number | undefined;
  /** Whether nothing has been read yet. */
  started: boolean;
  state: "idle" | "loading" | "failed";
}

const unread: Read = { raw: [], next: 0, started: false, state: "idle" };

/**
 * A step's raw payloads the daemon left out of the transcript (`rawOmitted`, hello trim
 * `raw-on-demand`): read with `item.raw` the first time the disclosure opens, a page at a time.
 */
export function OmittedRaw(props: { threadId: string; itemId: string }) {
  const client = useClient();
  const [read, setRead] = useState<Read>(unread);
  const load = async (from: number) => {
    setRead((current) => ({ ...current, state: "loading" }));
    try {
      const reply = await client.request({
        type: "item.raw",
        threadId: props.threadId,
        itemId: props.itemId,
        from,
      });
      setRead((current) => ({
        raw: [...current.raw, ...reply.raw],
        next: reply.next,
        started: true,
        state: "idle",
      }));
    } catch {
      setRead((current) => ({ ...current, state: "failed" }));
    }
  };
  const more = read.next !== undefined && read.state !== "loading";
  return (
    <Collapsible
      onOpenChange={(open) => {
        if (open && !read.started && read.state !== "loading") void load(0);
      }}
    >
      <CollapsibleTrigger className="self-start text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline">
        Raw
      </CollapsibleTrigger>
      <CollapsibleContent>
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
          <Button variant="ghost" size="sm" onClick={() => void load(read.next ?? 0)}>
            {read.state === "failed" ? "Retry" : "Show more"}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
