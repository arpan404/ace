import { useId, useState } from "react";
import { StepDetail } from "./step-detail.tsx";
import { useToolStep, useWorkLog } from "./use-work-log.ts";
import { StepRow, WorkLogHeader } from "./work-log-view.tsx";

/**
 * "Worked for 4m 12s › Explored 6 files · Ran 3 commands · Edited 2 files". The whole tool log
 * at rest; expanding shows each step as a quiet row. Opens by itself when a step needs approval.
 */
export function WorkLog(props: { threadId: string; itemIds: readonly string[] }) {
  const headline = useWorkLog(props.threadId, props.itemIds);
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
          className="mt-0.5 mb-2 flex animate-in flex-col border-l-2 py-1 pl-2.5 duration-200 fade-in slide-in-from-top-1"
        >
          {props.itemIds.map((id) => (
            <ToolStep key={id} threadId={props.threadId} itemId={id} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row of the work log. Expands to its output, diff or reasoning. */
export function ToolStep(props: { threadId: string; itemId: string }) {
  const data = useToolStep(props.threadId, props.itemId);
  // A step shown while it waits for approval starts open.
  const [open, setOpen] = useState(data?.awaiting ?? false);
  const panel = useId();
  if (!data) return null;
  return (
    <li>
      <StepRow step={data.step} open={open} panel={panel} onToggle={() => setOpen(!open)} />
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6">
          <StepDetail item={data.item} />
        </div>
      )}
    </li>
  );
}
