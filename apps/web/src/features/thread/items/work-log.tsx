import { useItem } from "@ace/client-react";
import { MessageAttachments } from "@/components/attachment-message.tsx";
import { Suspense, use, useEffect, useId, useState } from "react";
import { DeferredWorkLogSteps } from "./deferred-steps.ts";
import { JumpedItem } from "./jumped-item.ts";
import { useWorkLog } from "./use-work-log.ts";
import { WorkLogHeader } from "./work-log-view.tsx";

const Steps = DeferredWorkLogSteps.Component;

/**
 * "Worked for 4m 12s › Explored 6 files · Ran 3 commands · Edited 2 files". The whole tool log
 * at rest; expanding shows each step as a quiet row, and what the agent said between steps.
 * Opens by itself when a step needs approval, or when a jump or a search hit lands inside it.
 */
export function WorkLog(props: {
  threadId: string;
  itemIds: readonly string[];
  live?: boolean;
  ongoing?: boolean | undefined;
  /** When its stretch closed: its time never runs past it. */
  until?: number | undefined;
  /** Time the agent sat idle between two of its runs inside the log. */
  idle?: number | undefined;
}) {
  const headline = useWorkLog(props.threadId, props.itemIds, {
    live: props.live,
    ongoing: props.ongoing,
    until: props.until,
    idle: props.idle,
  });
  const [toggled, setOpen] = useState<boolean>();
  const jumped = use(JumpedItem);
  const landed = jumped !== undefined && props.itemIds.includes(jumped);
  const open = toggled ?? (landed || (headline?.awaiting ?? false));
  const panel = useId();
  // Rows load after first paint, ready before the log is opened.
  useEffect(() => void DeferredWorkLogSteps.preload(), []);
  if (!headline) return null;
  return (
    <div>
      <WorkLogHeader
        headline={headline}
        open={open}
        panel={panel}
        onToggle={() => setOpen(!open)}
      />
      {!open &&
        props.itemIds.map((itemId) => (
          <WorkLogImage key={itemId} threadId={props.threadId} itemId={itemId} />
        ))}
      {open && (
        <Suspense fallback={null}>
          <Steps threadId={props.threadId} itemIds={props.itemIds} panel={panel} />
        </Suspense>
      )}
    </div>
  );
}

function WorkLogImage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (
    item?.type !== "tool_call" ||
    item.call.detail.kind !== "image" ||
    !item.call.detail.attachment
  )
    return null;
  return (
    <MessageAttachments
      threadId={props.threadId}
      attachments={[item.call.detail.attachment]}
      className="my-2 items-start"
    />
  );
}
