import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { ToolSurface } from "@ace/protocol";
import { isMeasurementCall, reviewedInteraction, type StepText } from "@ace/ui-core";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { Suspense, useId, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { DeferredMeasurementStep } from "./deferred-measurement.ts";
import { DeferredReviewNote } from "./deferred-review.ts";
import { MessageAttachments } from "@/components/attachment-message.tsx";
import { StepDetail } from "./step-detail.tsx";
import { StepImages } from "./ace-steps.tsx";
import { StepGlyph } from "./step-glyph.tsx";
import { StepProse } from "./step-prose.tsx";
import { useStepDisplay } from "./use-step-display.ts";

/*
 * One work-log step as a quiet row that expands to its detail, and what the agent said between
 * steps as prose. Rows are grouped by `step-groups-view.tsx`.
 */

/**
 * One row of the work log. Expands to its output, diff or reasoning. ace's review of a step
 * sits right under that step; a smoothness measurement opens to its card.
 */
export function ToolStepContent(props: {
  threadId: string;
  itemId: string;
  ace?: AceToolContext | undefined;
  retried?: boolean | undefined;
  surface?: ToolSurface | undefined;
}) {
  const data = useStepDisplay(props.threadId, props.itemId, props.ace);
  const item = data?.item;
  const display =
    data && props.retried
      ? { ...data, step: { ...data.step, note: undefined, failed: false } }
      : data;
  if (item?.type === "tool_call" && item.call.detail.kind === "plan") return null;
  // What the agent said between two steps.
  if (item?.type === "message")
    return (
      <li className="py-1.5">
        <StepProse threadId={props.threadId} itemId={props.itemId} />
      </li>
    );
  if (item?.type === "notice" && reviewedInteraction(item))
    return (
      <li className="py-1">
        <Suspense fallback={<p className="text-ui text-muted-foreground">{item.text}</p>}>
          <DeferredReviewNote.Component threadId={props.threadId} item={item} />
        </Suspense>
      </li>
    );
  const line = <StepLine threadId={props.threadId} data={display} surface={props.surface} />;
  if (
    data &&
    ((item?.type === "tool_call" && (item.measurement || isMeasurementCall(item.call))) ||
      (item?.type === "notice" && item.measurement))
  )
    return (
      <Suspense fallback={line}>
        <DeferredMeasurementStep.Component threadId={props.threadId} data={data} plain={line} />
      </Suspense>
    );
  return line;
}

function StepLine(props: {
  threadId: string;
  data: ReturnType<typeof useStepDisplay>;
  surface?: ToolSurface | undefined;
}) {
  const { data } = props;
  // Details start folded; pending requests remain visible above the composer.
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (!data || data.awaiting) return null;
  const expandable = hasStepDetail(data.item);
  return (
    <li>
      <StepRow
        threadId={props.threadId}
        step={data.step}
        item={data.item}
        surface={props.surface}
        open={open}
        panel={panel}
        onToggle={() => setOpen(!open)}
        expandable={expandable}
      />
      {data.step.ace && data.step.ace.images.length > 0 && <StepImages view={data.step.ace} />}
      {data.item.type === "tool_call" &&
        data.item.call.detail.kind === "image" &&
        data.item.call.detail.attachment &&
        !open && (
          <MessageAttachments
            threadId={props.threadId}
            attachments={[data.item.call.detail.attachment]}
            className="mt-1 items-start pl-6.5"
          />
        )}
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6.5">
          <StepDetail item={data.item} threadId={props.threadId} ace={data.step.ace} />
        </div>
      )}
    </li>
  );
}

/** One quiet step row: glyph or spinner, verb, target, diff stat and note. */
export function StepRow(props: {
  threadId: string;
  step: StepText;
  item?: import("@ace/protocol").Item | undefined;
  surface?: ToolSurface | undefined;
  open: boolean;
  panel: string;
  onToggle(): void;
  expandable?: boolean;
}) {
  const { step } = props;
  return (
    <button
      type="button"
      aria-expanded={props.expandable === false ? undefined : props.open}
      aria-controls={props.panel}
      aria-label={[step.verb, step.target, step.note].filter(Boolean).join(" ")}
      title={step.ace?.problem?.hint}
      onClick={props.expandable === false ? undefined : props.onToggle}
      className="flex min-h-8 w-full min-w-0 items-center gap-2.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground"
    >
      <StepGlyph
        threadId={props.threadId}
        item={props.item}
        surface={props.surface}
        mark={step.ace?.mark}
        running={!step.settled}
        failed={step.failed}
      />
      <span
        className={cn(
          step.target ? "shrink-0" : "min-w-0 truncate",
          !step.settled && "step-shimmer",
        )}
      >
        {step.verb}
      </span>
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
        {step.note && step.note !== "Waiting for your approval" && (
          <span className={cn(step.failed && "text-status-failed")}>{step.note}</span>
        )}
      </span>
    </button>
  );
}

export function ToolStep(props: React.ComponentProps<typeof ToolStepContent>) {
  return (
    <LocalBoundary label="this step">
      <ToolStepContent {...props} />
    </LocalBoundary>
  );
}

function hasStepDetail(item: import("@ace/protocol").Item): boolean {
  if (item.type !== "tool_call") return item.type === "reasoning" || item.type === "notice";
  const detail = item.call.detail;
  if (item.call.error) return true;
  if (detail.kind === "shell") return !!detail.output;
  if (detail.kind === "search") return false;
  if (detail.kind === "web.search" || detail.kind === "web.fetch" || detail.kind === "file.read")
    return false;
  return true;
}
