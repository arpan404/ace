import type { ThreadReader } from "@ace/client";
import { useMemo } from "react";
import { cn } from "@/lib/cn.ts";
import { useWatched } from "@/lib/use-watched.ts";
import { usageWarning } from "../lib/usage-warning.ts";
import { flatEqual } from "../lib/use-items.ts";

/** Append-only reads inspect new items; a replaced history window resets the bounded cursor. */
function warningReader(threadId: string) {
  let first: string | undefined;
  let last: string | undefined;
  let length = 0;
  let latest: string | undefined;
  return (reader: ThreadReader) => {
    if (reader.thread?.id !== threadId) return { value: undefined, watch: [] };
    const order = reader.order;
    if (order[0] !== first || order.length < length || order[length - 1] !== last) {
      length = 0;
      latest = undefined;
    }
    for (let at = length; at < order.length; at++) {
      const id = order[at];
      if (id && usageWarning(reader.item(id))) latest = id;
    }
    first = order[0];
    last = order.at(-1);
    length = order.length;
    return {
      value: latest ? usageWarning(reader.item(latest)) : undefined,
      watch: latest ? [`item:${latest}`] : [],
    };
  };
}
const keys = ["order", "thread"] as const;
export function UsageNotice(props: { threadId: string }) {
  const read = useMemo(() => warningReader(props.threadId), [props.threadId]);
  const warning = useWatched(
    props.threadId,
    keys,
    read,
    (a, b) => a === b || (!!a && !!b && flatEqual(a, b)),
  );
  return warning ? (
    <p
      role="status"
      className={cn(
        "px-3 pb-1 text-xs text-subtle-foreground",
        warning.urgent && "text-status-needs-you",
      )}
    >
      {warning.label}
    </p>
  ) : null;
}
