import { Suspense, useId, useState } from "react";
import { reviewedInteraction } from "@ace/ui-core";
import { DeferredStepDetail } from "../deferred.ts";
import { DeferredReviewNote } from "./deferred-review.ts";
import { useToolStep, useWorkLog } from "./use-work-log.ts";
import { StepRow, WorkLogHeader } from "./work-log-view.tsx";

const StepDetail = DeferredStepDetail.Component;

/**
 * "Worked for 4m 12s › Explored 6 files · Ran 3 commands · Edited 2 files". The whole tool log
 * at rest; expanding shows each step as a quiet row. Opens by itself when a step needs approval.
 */
export function WorkLog(props: {
  threadId: string;
  itemIds: readonly string[];
  live?: boolean;
  /** When its stretch closed: its time never runs past it. */
  until?: number | undefined;
}) {
  const headline = useWorkLog(props.threadId, props.itemIds, props.live, props.until);
  const [toggled, setOpen] = useState<boolean>();
  const open = toggled ?? headline?.awaiting ?? false;
  const panel = useId();
  if (!headline) return null;
  return (
    <div>
      <WorkLogHeader
        headline={headline}
        open={open}
        panel={panel}
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <ul
          id={panel}
          aria-label="Steps"
          className="fx-rise-in mt-0.5 mb-2 flex flex-col border-l-2 py-1 pl-2.5"
        >
          {props.itemIds.map((id) => (
            <ToolStep key={id} threadId={props.threadId} itemId={id} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One row of the work log. Expands to its output, diff or reasoning. ace's review of a step
 * sits right under that step.
 */
export function ToolStep(props: { threadId: string; itemId: string }) {
  const data = useToolStep(props.threadId, props.itemId);
  const item = data?.item;
  if (item?.type === "notice" && reviewedInteraction(item))
    return (
      <li className="py-1 pl-1.5">
        <Suspense fallback={<p className="text-ui text-muted-foreground">{item.text}</p>}>
          <DeferredReviewNote.Component threadId={props.threadId} item={item} />
        </Suspense>
      </li>
    );
  return <StepLine threadId={props.threadId} data={data} />;
}

function StepLine(props: { threadId: string; data: ReturnType<typeof useToolStep> }) {
  const { data } = props;
  // A step shown while it waits for approval starts open.
  const [open, setOpen] = useState(data?.awaiting ?? false);
  const panel = useId();
  if (!data) return null;
  return (
    <li>
      <StepRow step={data.step} open={open} panel={panel} onToggle={() => setOpen(!open)} />
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6">
          <Suspense fallback={null}>
            <StepDetail item={data.item} threadId={props.threadId} />
          </Suspense>
        </div>
      )}
    </li>
  );
}
