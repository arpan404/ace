import type { ThreadReader } from "@ace/client";
import { useClient, useItem, useThread, useThreadMeta } from "@ace/client-react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, useDaemonReady } from "@/lib/daemon-command.ts";
import { useThreadSources } from "../sources/index.ts";
import { retryPointOf, sameRetryPoint, type EditPoint, type RetryPoint } from "./edit-point.ts";
import { resendPayload } from "./resend.ts";

/*
 * Retry on the transcript's newest answer, through what the daemon already offers: Pi rewinds its
 * own session in place (`pi.control` rollback). A control that can't act renders nothing, never
 * a disabled button.
 */

const watched = ["thread", "order"] as const;

/** Where a retry of answer `itemId` would start, when it is the newest answer. */
export function useRetryPoint(threadId: string, itemId: string): RetryPoint | undefined {
  const read = useCallback(
    (reader: ThreadReader) => retryPointOf(reader, itemId, reader.thread?.rootAgentId),
    [itemId],
  );
  return useThread(threadId, watched, read, sameRetryPoint);
}

/** Pi goes back in place: a Pi thread, settled, connected, with a Pi entry to go back to. */
function usePiEntry(threadId: string, point: EditPoint): string | undefined {
  const meta = useThreadMeta(threadId);
  const ready = useDaemonReady().ready;
  const settled = meta?.status.state === "done" || meta?.status.state === "failed";
  return meta?.provider === "pi" && settled && ready ? point.piEntry : undefined;
}

/**
 * Retry the newest answer, in place: Pi goes back to just before the message that asked for it
 * and asks again. No other provider can replace an answer in place, so there it renders nothing.
 */
export function RetryAnswerButton(props: { threadId: string; point: RetryPoint }) {
  const { threadId, point } = props;
  const ask = useItem(threadId, point.askId);
  const piEntry = usePiEntry(threadId, point.point);
  const sources = useThreadSources();
  const client = useClient();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const payload = resendPayload(threadId, ask);
  if (!payload || !piEntry) return null;
  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void sources.actions
      .rewind(threadId, piEntry)
      .then(() => client.enqueue(payload))
      .catch((failure: unknown) =>
        toast.error({ title: "Couldn't retry the answer", description: failureMessage(failure) }),
      )
      .finally(() => setRetrying(false));
  };
  return (
    <IconButton
      icon={ArrowClockwiseIcon}
      label="Retry"
      size="sm"
      disabled={retrying}
      onClick={retry}
    />
  );
}
