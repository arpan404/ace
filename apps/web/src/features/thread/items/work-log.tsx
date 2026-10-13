import { formatClock } from "@ace/ui-core";
import { Suspense, use, useEffect, useId, useMemo, useState } from "react";
import { useTurnSummary } from "../long/turn-index.ts";
import { blockItems, type Block } from "../transcript/blocks.ts";
import { DeferredTurnWork } from "./deferred-steps.ts";
import { JumpedItem } from "./jumped-item.ts";
import { GroupedSteps } from "./step-groups-view.tsx";
import { useWorkLog } from "./use-work-log.ts";
import { StepsSkeleton, WorkLogHeader, WorkLogLine } from "./work-log-view.tsx";

const TurnWork = DeferredTurnWork.Component;

type WorkBlock = Extract<Block, { kind: "work" }>;

/**
 * A turn's tool work. While the turn works, its steps stream in groups under the turn's live
 * header, the newest step in view. Once the whole tree settles, a completed turn folds into
 * "Worked for 2m 5s ›" (its answer, failures and changed files stay in view) and its steps load
 * when it opens; a failed or stopped one keeps its log a click away. A jump or search hit inside
 * opens it.
 */
export function WorkLog(props: {
  threadId: string;
  block: WorkBlock;
  ordinal?: number | undefined;
}) {
  if (props.block.ongoing)
    return <GroupedSteps threadId={props.threadId} itemIds={props.block.itemIds} live />;
  return <SettledLog {...props} />;
}

function SettledLog(props: { threadId: string; block: WorkBlock; ordinal?: number | undefined }) {
  const { block } = props;
  // Only a turn's head (the block that carries its outcome) speaks for the whole turn.
  const summary = useTurnSummary(
    props.threadId,
    block.outcome === undefined ? undefined : props.ordinal,
  );
  const headline = useWorkLog(props.threadId, block.itemIds, {
    until: block.until,
    idle: block.idle,
    startedAt: block.startedAt,
    outcome: block.outcome,
    summary: summary?.endedAt === undefined ? undefined : summary,
  });
  const [toggled, setOpen] = useState<boolean>();
  const jumped = use(JumpedItem);
  const items = useMemo(() => blockItems(block), [block]);
  const landed = jumped !== undefined && items.includes(jumped);
  const open = toggled ?? landed;
  const panel = useId();
  // The opened log's code loads after first paint, ready before it is opened.
  useEffect(() => void DeferredTurnWork.preload(), []);
  if (!headline) return null;
  // Nothing behind it (only an answer, and the daemon's digest counts no tools): plain text,
  // not a disclosure that opens on "No steps recorded".
  const answers = new Set(block.answerIds);
  const digest = summary?.digest;
  if (
    digest &&
    !items.some((id) => !answers.has(id)) &&
    digest.commandsRun === 0 &&
    !Object.values(digest.toolCounts).some(Boolean)
  )
    return (
      <WorkLogLine
        label={headline.label}
        time={headline.endedAt === undefined ? undefined : formatClock(headline.endedAt)}
      />
    );
  return (
    <div>
      <WorkLogHeader
        label={headline.label}
        time={headline.endedAt === undefined ? undefined : formatClock(headline.endedAt)}
        open={open}
        panel={panel}
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <div className="pt-1 pb-1">
          <Suspense fallback={<StepsSkeleton />}>
            <TurnWork
              threadId={props.threadId}
              block={block}
              ordinal={props.ordinal}
              endSeq={summary?.endSeq}
              panel={panel}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
