import type { ToolSurface } from "@ace/protocol";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { HammerIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { StepGlyph } from "./step-glyph.tsx";
import { useStepDisplay } from "./use-step-display.ts";

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
      <>
        <Icon icon={HammerIcon} size={16} className="text-subtle-foreground" />
        <span className="step-shimmer min-w-0 truncate">Working</span>
      </>
    );
  const { item, step } = data;
  if (data.awaiting)
    return (
      <>
        <StepGlyph threadId={props.threadId} item={item} running={false} failed={false} />
        <span className="min-w-0 truncate">Waiting for your approval</span>
      </>
    );
  return (
    <>
      <StepGlyph
        threadId={props.threadId}
        item={item}
        surface={props.surface}
        mark={step.ace?.mark}
        running={!step.settled}
        failed={step.failed}
      />
      <span className="min-w-0 truncate">
        <span className={cn(!step.settled && "step-shimmer")}>
          {step.verb}
          {step.target ? ` ${step.target}` : ""}
        </span>
        {props.count > 1 && <span className="text-subtle-foreground"> · {props.count} steps</span>}
      </span>
    </>
  );
}
