import { Suspense, useEffect, useId, useState } from "react";
import { DeferredWorkLogSteps } from "./deferred-steps.ts";
import { useWorkLog } from "./use-work-log.ts";
import { WorkLogHeader } from "./work-log-view.tsx";

const Steps = DeferredWorkLogSteps.Component;

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
      {open && (
        <Suspense fallback={null}>
          <Steps threadId={props.threadId} itemIds={props.itemIds} panel={panel} />
        </Suspense>
      )}
    </div>
  );
}
