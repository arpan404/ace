import type { ThreadReader } from "@ace/client";
import { useCallback } from "react";
import { useWatched, type Watched } from "@/lib/use-watched.ts";

const keys = ["order", "queue"] as const;
const none: Watched<string | undefined> = { value: undefined, watch: [] };

/** The kept queue head owns its correction; retries update the same persisted notice. */
export function RetainedInputDetail(props: { threadId: string; commandId: string | undefined }) {
  const read = useCallback(
    (reader: ThreadReader): Watched<string | undefined> => {
      if (!props.commandId) return none;
      for (let at = reader.order.length - 1; at >= 0; at--) {
        const item = reader.item(reader.order[at] ?? "");
        if (
          item?.type === "notice" &&
          item.code === "input_queued" &&
          item.commandId === props.commandId
        )
          return { value: item.detail, watch: [`item:${item.id}`] };
      }
      return none;
    },
    [props.commandId],
  );
  const detail = useWatched(props.threadId, keys, read, Object.is);
  return detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null;
}
