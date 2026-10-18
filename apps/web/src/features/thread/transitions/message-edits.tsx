import type { ThreadReader } from "@ace/client";
import { useClient, useItem, useThread, useThreadMeta } from "@ace/client-react";
import { sanitizeUserText } from "@ace/ui-core";
import { ArrowClockwiseIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, useDaemonReady } from "@/lib/daemon-command.ts";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useLayout } from "@/lib/layout.tsx";
import { draftOf, restoreReturnedDraft } from "../composer/returned-draft.ts";
import { inputText } from "../composer/send-store.ts";
import { useThreadSources } from "../sources/index.ts";
import {
  editPointOf,
  retryPointOf,
  sameEditPoint,
  sameRetryPoint,
  type EditPoint,
  type RetryPoint,
} from "./edit-point.ts";
import { useForkOpener } from "./fork-opener.ts";
import { resendPayload } from "./resend.ts";

/*
 * Edit and Retry on the transcript's messages, through what the daemon already offers: Pi
 * rewinds its own session in place (`pi.control` rollback); every provider can fork from the
 * turn before. A control that can't act renders nothing, never a disabled button.
 */

const watched = ["thread", "order"] as const;

/** Where an edit of the person's message `itemId` would continue from. */
export function useEditPoint(threadId: string, itemId: string): EditPoint | undefined {
  const read = useCallback(
    (reader: ThreadReader) => editPointOf(reader, itemId, reader.thread?.rootAgentId),
    [itemId],
  );
  return useThread(threadId, watched, read, sameEditPoint);
}

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
 * Edit the person's message: the thread goes back to just before it and its text returns for
 * sending again. Pi rewinds in place and the text goes to the composer; other providers open a
 * fork from the turn before with the text as its first message.
 */
export function EditMessageButton(props: { threadId: string; itemId: string; point: EditPoint }) {
  const { threadId, point } = props;
  const item = useItem(threadId, props.itemId);
  const piEntry = usePiEntry(threadId, point);
  const fork = useForkOpener();
  const sources = useThreadSources();
  const { storage } = useLayout();
  const toast = useToast();
  const payload = resendPayload(threadId, item);
  if (!payload || (!piEntry && !fork)) return null;
  const edit = () => {
    if (!piEntry) return fork?.(point.fork, sanitizeUserText(inputText(payload.input)));
    void sources.actions.rewind(threadId, piEntry).then(
      () => {
        if (restoreReturnedDraft(storage, `thread:${threadId}`, draftOf(payload)))
          focusComposerSoon();
        else toast.error({ title: "Couldn't put the message back in the composer" });
      },
      (failure: unknown) =>
        toast.error({
          title: "Couldn't go back to this message",
          description: failureMessage(failure),
        }),
    );
  };
  return <IconButton icon={PencilSimpleIcon} label="Edit message" size="sm" onClick={edit} />;
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
