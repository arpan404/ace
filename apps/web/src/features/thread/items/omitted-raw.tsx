import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useClient } from "@ace/client-react";
import type { RawPayload } from "@ace/protocol";
import { useState } from "react";

type Read =
  | { state: "idle" | "loading" | "failed" }
  | { state: "read"; raw: readonly RawPayload[]; truncated: boolean };

/**
 * A step's raw payloads the daemon left out of the transcript (`rawOmitted`, hello trim
 * `raw-on-demand`): read with `item.raw` the first time the disclosure opens.
 */
export function OmittedRaw(props: { threadId: string; itemId: string }) {
  const client = useClient();
  const [read, setRead] = useState<Read>({ state: "idle" });
  const load = async () => {
    setRead({ state: "loading" });
    try {
      const reply = await client.request({
        type: "item.raw",
        threadId: props.threadId,
        itemId: props.itemId,
      });
      setRead({ state: "read", raw: reply.raw, truncated: reply.truncated === true });
    } catch {
      setRead({ state: "failed" });
    }
  };
  return (
    <Collapsible
      onOpenChange={(open) => {
        if (open && (read.state === "idle" || read.state === "failed")) void load();
      }}
    >
      <CollapsibleTrigger className="self-start text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline">
        Raw
      </CollapsibleTrigger>
      <CollapsibleContent>
        {read.state === "loading" && <Spinner />}
        {read.state === "failed" && (
          <p role="alert" className="text-xs text-muted-foreground">
            Couldn't read the raw payloads. Close and open to retry.
          </p>
        )}
        {read.state === "read" && (
          <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(read.raw, null, 2)}
            {read.truncated ? "\n…" : ""}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
