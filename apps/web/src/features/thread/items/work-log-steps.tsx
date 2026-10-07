import {
  BrainIcon,
  EyeIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  NoteIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { isMeasurementCall, reviewedInteraction, type StepIcon, type StepText } from "@ace/ui-core";
import { Suspense, useId, useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { DeferredMeasurementStep } from "./deferred-measurement.ts";
import { DeferredReviewNote } from "./deferred-review.ts";
import { StepDetail } from "./step-detail.tsx";
import { useStepDisplay } from "./use-step-display.ts";

/*
 * A work log's rows, shown when it opens: each step as a quiet line that expands to its
 * detail. Loaded after first paint (logs start collapsed), with the step wording.
 */

const icons: Record<StepIcon, PhosphorIcon> = {
  read: EyeIcon,
  search: MagnifyingGlassIcon,
  shell: TerminalIcon,
  edit: NotePencilIcon,
  web: GlobeIcon,
  tool: WrenchIcon,
  think: BrainIcon,
  note: NoteIcon,
};

/** The open log's steps. */
export function WorkLogSteps(props: {
  threadId: string;
  itemIds: readonly string[];
  panel: string;
}) {
  return (
    <ul
      id={props.panel}
      aria-label="Steps"
      className="fx-rise-in mt-0.5 mb-2 flex flex-col border-l-2 py-1 pl-2.5"
    >
      {props.itemIds.map((id) => (
        <ToolStep key={id} threadId={props.threadId} itemId={id} />
      ))}
    </ul>
  );
}

/**
 * One row of the work log. Expands to its output, diff or reasoning. ace's review of a step
 * sits right under that step; a smoothness measurement opens to its card.
 */
export function ToolStep(props: { threadId: string; itemId: string }) {
  const data = useStepDisplay(props.threadId, props.itemId);
  const item = data?.item;
  if (item?.type === "notice" && reviewedInteraction(item))
    return (
      <li className="py-1 pl-1.5">
        <Suspense fallback={<p className="text-ui text-muted-foreground">{item.text}</p>}>
          <DeferredReviewNote.Component threadId={props.threadId} item={item} />
        </Suspense>
      </li>
    );
  const line = <StepLine threadId={props.threadId} data={data} />;
  if (data && item?.type === "tool_call" && isMeasurementCall(item.call))
    return (
      <Suspense fallback={line}>
        <DeferredMeasurementStep.Component data={data} plain={line} />
      </Suspense>
    );
  return line;
}

function StepLine(props: { threadId: string; data: ReturnType<typeof useStepDisplay> }) {
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
          <StepDetail item={data.item} threadId={props.threadId} />
        </div>
      )}
    </li>
  );
}

/** One quiet step row: glyph or spinner, verb, target, diff stat and note. */
export function StepRow(props: { step: StepText; open: boolean; panel: string; onToggle(): void }) {
  const { step } = props;
  const Glyph = icons[step.icon];
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-controls={props.panel}
      aria-label={[step.verb, step.target, step.note].filter(Boolean).join(" ")}
      onClick={props.onToggle}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent"
    >
      {step.settled ? (
        <Glyph aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
      ) : (
        <Spinner className="mx-px" />
      )}
      <span className="shrink-0">{step.verb}</span>
      {step.target && (
        <code className="min-w-0 truncate font-mono text-[12px] text-foreground">
          {step.target}
        </code>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-xs text-subtle-foreground">
        {step.added !== undefined && (step.added > 0 || (step.removed ?? 0) > 0) && (
          <span className="font-mono">
            <span className="text-status-done">+{step.added}</span>{" "}
            <span className="text-status-failed">−{step.removed ?? 0}</span>
          </span>
        )}
        {step.note && <span className={cn(step.failed && "text-status-failed")}>{step.note}</span>}
      </span>
    </button>
  );
}
