import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import { ArrowClockwiseIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useState } from "react";
import { beginQueueEdit, cancelQueueEdit, useQueueEdit } from "../composer/queue-edit.ts";
import { failedHead, shortReason } from "../composer/failed-head.ts";
import { useHeldQueue } from "../composer/queue-notice.tsx";
import { useRetainedInputDetail } from "../composer/retained-input-detail.tsx";
import { queuedText, useQueue } from "../composer/use-queue.ts";
import { NotSent } from "./failed-send.tsx";
import { ClearStaleLock } from "./clear-stale-lock.tsx";
import { userBubble } from "./user-bubble.ts";
import { BubbleText } from "./bubble-text.tsx";
import { HeldAttachments } from "./held-attachments.tsx";
import { cn } from "@/lib/cn.ts";

const failureOf = (reader: ThreadReader) => reader.queue?.lastFailure?.title;
const fencedOf = (reader: ThreadReader) => reader.queue?.lastFailure?.code === "git_quarantined";

/**
 * A message whose send or session start failed, at the end of the transcript where it was
 * written: the message, "Not sent · one short reason", Try again / Edit / Remove, and the
 * provider's technical detail behind Details. The daemon keeps it at the head of the held
 * queue; Try again resumes that queue. Edit changes its words where it waits: they open in the
 * composer, as a queued message's do, and Enter saves them fenced to the queue they were read
 * from, so nothing is removed to edit it. Remove asks first, then drops it.
 */
export function HeldSend(props: { threadId: string }) {
  const status = useThreadMeta(props.threadId)?.status;
  const queue = useQueue(props.threadId);
  const { storage } = useLayout();
  const session = useQueueEdit(props.threadId);
  const [removing, setRemoving] = useState(false);
  const held = useHeldQueue(props.threadId, status, queue);
  const message = failedHead(held, queue);
  const detail = useRetainedInputDetail(props.threadId, message?.id);
  const failure = useThread(props.threadId, ["queue"], failureOf) ?? queue.page?.lastFailure?.title;
  // Git's cleanup fence stopped it: the person may clear a lock a stopped daemon left.
  const fenced =
    useThread(props.threadId, ["queue"], fencedOf) ||
    queue.page?.lastFailure?.code === "git_quarantined";
  // Before the first queue page arrives the message isn't known yet; Try again still works.
  if (held?.notice.kind !== "not_sent" || (!message && queue.page)) return null;
  const startEdit = () => {
    if (!message) return;
    if (beginQueueEdit(storage, props.threadId, message, queue.page?.revision, true))
      focusComposerSoon();
  };
  const busy = queue.acting || (!!message && queue.busy(message.id));
  // Editing it in the composer: Try again would send the words being changed, so it waits.
  const editing = !!message && session?.message.id === message.id;
  const text = message ? queuedText(message) : "";
  return (
    <section aria-label="Message not sent" className="mt-4 flex flex-col items-end">
      {message && (
        <HeldAttachments
          threadId={props.threadId}
          message={message}
          className={cn("max-w-[80%]", text && "mb-1")}
        />
      )}
      {message && text && (
        <div className={userBubble}>
          <BubbleText text={text} />
        </div>
      )}
      <div
        role="alert"
        className="mt-[5px] flex flex-wrap items-center justify-end gap-x-1 gap-y-0.5"
      >
        <NotSent reason={shortReason(failure)} />
        {fenced && <ClearStaleLock target={{ threadId: props.threadId }} />}
        <span className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || editing}
            onClick={() => queue.act({ id: "resume", label: "Try again" })}
          >
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Try again
          </Button>
          {message && (
            <>
              {editing ? (
                <Button
                  size="xs"
                  variant="ghost"
                  title="Stop editing and bring back what you were writing"
                  onClick={() => cancelQueueEdit(props.threadId)}
                >
                  Cancel edit
                </Button>
              ) : (
                <Button size="xs" variant="ghost" disabled={busy} onClick={startEdit}>
                  <Icon icon={PencilSimpleIcon} size={12} />
                  Edit
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                tone="danger"
                disabled={busy}
                onClick={() => setRemoving(true)}
              >
                Remove
              </Button>
            </>
          )}
        </span>
      </div>
      {removing && message && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(false)}>
          <DialogContent>
            <DialogTitle>Remove this message?</DialogTitle>
            <DialogDescription>It won't be sent.</DialogDescription>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRemoving(false);
                  queue.remove(message);
                }}
              >
                Remove message
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {detail && (
        <Disclosure
          summary="Details"
          summaryClassName="ml-auto text-xs"
          className="mt-1 flex max-w-[82%] flex-col self-end"
        >
          <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground wrap-break-word">
            {detail}
          </p>
        </Disclosure>
      )}
    </section>
  );
}
