import { queuedDetail, queuedSlotFragment } from "@ace/ui-core";
import { BubbleText } from "../items/bubble-text.tsx";
import { userBubble } from "../items/user-bubble.ts";
import { readingColumn } from "../lib/column.ts";
import { ParentCrumb } from "../header/thread-crumb.tsx";

/**
 * A delegated thread still waiting for one of its parent's run slots: what it was asked, where a
 * thread starts with the person's message, and one line saying why nothing runs yet. A message
 * the person sends starts it at once.
 */
export function QueuedLaunch(props: {
  text: string;
  parentThreadId: string | undefined;
  slotLimit?: number | undefined;
  slotsInUse?: number | undefined;
  queuePosition?: number | undefined;
}) {
  const place =
    props.slotLimit !== undefined &&
    props.slotsInUse !== undefined &&
    props.queuePosition !== undefined
      ? queuedSlotFragment({
          slotLimit: props.slotLimit,
          slotsInUse: props.slotsInUse,
          queuePosition: props.queuePosition,
        })
      : undefined;
  return (
    <div className="col-start-1 row-start-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain">
      <div className={`${readingColumn} pt-6 pb-[calc(var(--composer-clearance,0px)+2rem)]`}>
        <div className="mb-6 flex flex-col items-end">
          <div className={userBubble}>
            <BubbleText text={props.text} />
          </div>
        </div>
        <p role="status" className="text-ui text-muted-foreground">
          {place ? (
            <>
              Queued: {place}. Starts when one finishes
              {props.parentThreadId && (
                <>
                  {" in "}
                  <ParentCrumb threadId={props.parentThreadId} />
                </>
              )}
              , or when you send it a message.
            </>
          ) : (
            <>
              Queued. {queuedDetail}
              {props.parentThreadId && (
                <>
                  {" in "}
                  <ParentCrumb threadId={props.parentThreadId} />
                </>
              )}
              , or when you send it a message.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
