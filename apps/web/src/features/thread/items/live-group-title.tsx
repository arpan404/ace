import type { ToolSurface } from "@ace/protocol";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { HammerIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { StepGlyph } from "./step-glyph.tsx";
import { RowParts } from "./transcript-row.tsx";
import { useStepDisplay } from "./use-step-display.ts";

/** A running group's row parts: its step in flight as the title, and how many steps it holds. */
export function LiveGroupTitle(props: {
  threadId: string;
  itemId: string;
  ace?: AceToolContext | undefined;
  surface?: ToolSurface | undefined;
  count: number;
}) {
  const data = useStepDisplay(props.threadId, props.itemId, props.ace);
  if (!data)
    return (
      <RowParts
        lead={<Icon icon={HammerIcon} size={16} />}
        title="Working"
        titleClassName="step-shimmer"
      />
    );
  const { item, step } = data;
  if (data.awaiting)
    return (
      <RowParts
        lead={<StepGlyph threadId={props.threadId} item={item} running={false} failed={false} />}
        title="Waiting for your approval"
      />
    );
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
