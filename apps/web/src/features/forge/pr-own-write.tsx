import { useCallback, useState } from "react";
import type { ForgeReviewAction } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { usePrReview } from "./pr-review-context.tsx";

type Status = { state: "saving" } | { state: "failed"; message: string } | undefined;

/**
 * A review write made from one place (a line comment, a reply, a pending comment), whose
 * progress and refusal show there, not in a status line that may be off screen. Writes from
 * other places never hold it.
 */
export function useOwnWrite() {
  const review = usePrReview();
  const [status, setStatus] = useState<Status>();
  const write = review?.write;
  const send = useCallback(
    async (action: ForgeReviewAction): Promise<boolean> => {
      if (!write) return false;
      setStatus({ state: "saving" });
      const result = await write(action);
      setStatus(result.ok ? undefined : { state: "failed", message: result.message });
      return result.ok;
    },
    [write],
  );
  return { send, saving: status?.state === "saving", status };
}

/** "Saving…" while a write is on its way; GitHub's refusal in its own words after. */
export function OwnWriteNote(props: {
  status: Status;
  className?: string | undefined;
  /** What this place says while it saves ("Posting…"). */
  saving?: string | undefined;
}) {
  const { status } = props;
  if (!status) return null;
  return (
    <p
      role={status.state === "failed" ? "alert" : "status"}
      className={cn(
        "text-xs",
        status.state === "failed" ? "text-status-failed" : "text-subtle-foreground",
        props.className,
      )}
    >
      {status.state === "failed" ? status.message : (props.saving ?? "Saving…")}
    </p>
  );
}
