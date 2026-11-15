import type { ToolSurface } from "@ace/protocol";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { HammerIcon } from "@ace/icons";
import { Icon } from "@/components/icon.tsx";
import { StepGlyph } from "./step-glyph.tsx";
import { RowParts } from "./transcript-row.tsx";
import { useStepDisplay } from "./use-step-display.ts";
import { useThreadLiveState } from "../lib/live-state.ts";

/**
 * The row parts of a group the agent is thinking after: the thought in flight as the title
 * ("Thinking"), and how many steps the group holds. Steps in flight never title a group; each is
 * a row of its own. While the thread's copy isn't current it says only that ("Syncing…"), with
 * no shimmer.
 */
export function LiveGroupTitle(props: {
  threadId: string;
  itemId: string;
  ace?: AceToolContext | undefined;
  surface?: ToolSurface | undefined;
  count: number;
}) {
  const data = useStepDisplay(props.threadId, props.itemId, props.ace);
  const { staleLabel } = useThreadLiveState(props.threadId);
  if (staleLabel !== undefined)
    return <RowParts lead={<Icon icon={HammerIcon} size={16} />} title={staleLabel} />;
  if (!data)
    return (
      <RowParts
        lead={<Icon icon={HammerIcon} size={16} />}
        title="Working"
        titleClassName="step-shimmer"
      />
    );
  const { item, step } = data;
  return (
    <RowParts
      lead={
        <StepGlyph
          threadId={props.threadId}
          item={item}
          surface={props.surface}
          mark={step.ace?.mark}
          running={!step.settled}
          failed={step.failed}
        />
      }
      title={
        <>
          <span className={step.settled ? undefined : "step-shimmer"}>
            {step.verb}
            {step.target ? ` ${step.target}` : ""}
          </span>
          {props.count > 1 && (
            <span className="text-subtle-foreground"> · {props.count} steps</span>
          )}
        </>
      }
    />
  );
}
