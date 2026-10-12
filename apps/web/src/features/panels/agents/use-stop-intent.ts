import { useIntentSender } from "@ace/client-react";
import type { CommandPayload } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";

/** Stop is single-flight from the first click through persistence and the command receipt. */
export function useStopIntent() {
  const sender = useIntentSender();
  const guard = useRef(false);
  const [enqueuing, setEnqueuing] = useState(false);
  const pending = sender.intent?.state === "pending";
  useEffect(() => {
    if (!enqueuing && sender.intent?.state !== "pending") guard.current = false;
  }, [enqueuing, sender.intent]);
  const send = async (payload: CommandPayload) => {
    if (guard.current || pending) return;
    guard.current = true;
    setEnqueuing(true);
    try {
      await sender.send(payload);
    } catch {
      guard.current = false;
      // useIntentSender retains the enqueue error for friendly feedback and retry.
    } finally {
      setEnqueuing(false);
    }
  };
  return {
    send,
    busy: enqueuing || pending,
    failed: !enqueuing && (sender.error !== undefined || sender.intent?.state === "failed"),
  };
}
