import type { ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import { ArrowClockwiseIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { failedHead, shortReason } from "../composer/failed-head.ts";
import { useHeldQueue } from "../composer/queue-notice.tsx";
import { useRetainedInputDetail } from "../composer/retained-input-detail.tsx";
import { queuedText, useQueue } from "../composer/use-queue.ts";
import { NotSent } from "./failed-send.tsx";
import { userBubble } from "./user-bubble.ts";

const failureOf = (reader: ThreadReader) => reader.queue?.lastFailure?.title;

/**
 * A message whose send or session start failed, at the end of the transcript where it was
 * written: the message, "Not sent · one short reason", Try again / Edit / Remove, and the
 * provider's technical detail behind Details. The daemon keeps it at the head of the held
 * queue; Try again resumes that queue, Edit takes it back into the composer, Remove drops it.
 */
export function HeldSend(props: { threadId: string }) {
  const status = useThreadMeta(props.threadId)?.status;
  const queue = useQueue(props.threadId);
  const held = useHeldQueue(props.threadId, status, queue);
  const message = failedHead(held, queue);
  const detail = useRetainedInputDetail(props.threadId, message?.id);
  const failure = useThread(props.threadId, ["queue"], failureOf) ?? queue.page?.lastFailure?.title;
  // Before the first queue page arrives the message isn't known yet; Try again still works.
  if (held?.notice.kind !== "not_sent" || (!message && queue.page)) return null;
  const busy = queue.acting || (!!message && queue.busy(message.id));
  const files = message?.context?.attachments.length ?? 0;
  const text = message ? queuedText(message) : "";
  return (
    <section aria-label="Message not sent" className="mt-4 flex flex-col items-end">
      {message && (
        <div className={userBubble}>
          {text || `${files} attached ${files === 1 ? "file" : "files"}`}
        </div>
      )}
      <div
        role="alert"
        className="mt-[5px] flex flex-wrap items-center justify-end gap-x-2 gap-y-1"
      >
        <NotSent reason={shortReason(failure)} />
        <span className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => queue.act({ id: "resume", label: "Try again" })}
          >
            <Icon icon={ArrowClockwiseIcon} size={12} />
            Try again
          </Button>
          {message && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => queue.takeBack(message)}
              >
                <Icon icon={PencilSimpleIcon} size={12} />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => queue.remove(message)}
              >
                Remove
              </Button>
            </>
          )}
        </span>
      </div>
      {detail && (
        <Disclosure
          summary="Details"
          summaryClassName="ml-auto"
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
