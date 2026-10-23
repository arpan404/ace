import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { Item, ToolSurface } from "@ace/protocol";
import { isMeasurementCall, opensAgentPage, stepOpens, type StepText } from "@ace/ui-core";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { Suspense, useId } from "react";
import { cn } from "@/lib/cn.ts";
import { useShowBrowserPanel } from "@/features/panels/index.ts";
import { DeferredMeasurementStep } from "./deferred-measurement.ts";
import { DeferredQuestionStep } from "../interactions/deferred-card.ts";
import { MessageAttachments } from "@/components/attachment-message.tsx";
import { StepDetail } from "./step-detail.tsx";
import { StepImages } from "./ace-steps.tsx";
import { StepGlyph } from "./step-glyph.tsx";
import { RailMark } from "./step-rail.tsx";
import { StepProse } from "./step-prose.tsx";
import { useStepDisplay } from "./use-step-display.ts";
import { useStepOpen } from "./step-open.ts";
import { pressableRowClass, rowClass } from "./transcript-row.tsx";

/*
 * One work-log step as a quiet row that expands to its detail, and what the agent said between
 * steps as prose. Rows are grouped by `step-groups-view.tsx`.
 */

/**
 * One row of the work log. Expands to its output, diff or reasoning; a smoothness measurement
 * opens to its card.
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
  const line = opensAgentPage(item) ? (
    <PageStepLine
      threadId={props.threadId}
      itemId={props.itemId}
      data={display}
      surface={props.surface}
    />
  ) : (
    <StepLine
      threadId={props.threadId}
      itemId={props.itemId}
      data={display}
      surface={props.surface}
    />
  );
  // A question the agent asked reads as the question beside its answer.
  if (item?.type === "tool_call" && item.call.detail.kind === "ask_user")
    return (
      <Suspense fallback={line}>
        <DeferredQuestionStep.Component
          threadId={props.threadId}
          itemId={props.itemId}
          fallback={line}
        />
      </Suspense>
    );
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
  itemId: string;
  data: ReturnType<typeof useStepDisplay>;
  surface?: ToolSurface | undefined;
}) {
  const { data } = props;
  // Details start folded; pending requests remain visible above the composer. What the reader
  // opened stays open when the step joins a group.
  const [toggled, setOpen] = useStepOpen(props.itemId);
  const open = toggled ?? false;
  const panel = useId();
  if (!data || data.awaiting) return null;
  const expandable = stepOpens(data.item);
  return (
    <li className="relative">
      <RailMark state={!data.step.settled ? "running" : data.step.failed ? "failed" : "done"} />
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
            className="mt-1 items-start pl-7"
          />
        )}
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-7">
          <StepDetail item={data.item} threadId={props.threadId} ace={data.step.ace} />
        </div>
      )}
    </li>
  );
}

/**
 * An agent opening a page in the thread's browser. The page is one of the thread's Browser tabs,
 * so the row brings the Browser forward in the side panel, whether or not this device opens the
 * panel by itself when an agent opens a page.
 */
function PageStepLine(props: {
  threadId: string;
  itemId: string;
  data: ReturnType<typeof useStepDisplay>;
  surface?: ToolSurface | undefined;
}) {
  const { data } = props;
  const show = useShowBrowserPanel(props.threadId);
  if (!data || data.awaiting) return null;
  return (
    <li className="relative">
      <RailMark state={data.step.settled ? "done" : "running"} />
      <StepRow
        threadId={props.threadId}
        step={data.step}
        item={data.item}
        surface={props.surface}
        onOpen={() => show()}
      />
      {data.step.ace && data.step.ace.images.length > 0 && <StepImages view={data.step.ace} />}
    </li>
  );
}

/**
 * One quiet step row: glyph or spinner, verb, target, diff stat and note. It toggles the step's
 * detail (`panel`), or with `onOpen` shows what the step made somewhere else.
 */
export function StepRow(
  props: {
    threadId: string;
    step: StepText;
    item?: Item | undefined;
    surface?: ToolSurface | undefined;
  } & (
    | { open: boolean; panel: string; onToggle(): void; expandable?: boolean; onOpen?: never }
    | { onOpen(): void; open?: never; panel?: never; onToggle?: never; expandable?: never }
  ),
) {
  const { step } = props;
  const toggles = !props.onOpen && props.expandable !== false;
  return (
    <button
      type="button"
      aria-expanded={toggles ? props.open : undefined}
      aria-controls={toggles ? props.panel : undefined}
      aria-label={[step.verb, step.target, step.note].filter(Boolean).join(" ")}
      title={step.ace?.problem?.hint}
      onClick={props.onOpen ?? (toggles ? props.onToggle : undefined)}
      className={cn(
        props.onOpen || toggles ? pressableRowClass : rowClass,
        "text-muted-foreground",
      )}
    >
      <span className="flex min-w-5 shrink-0 items-center justify-center text-subtle-foreground">
        <StepGlyph
          threadId={props.threadId}
          item={props.item}
          surface={props.surface}
          mark={step.ace?.mark}
          running={!step.settled}
          failed={step.failed}
        />
      </span>
      <span
        className={cn(
          step.target ? "shrink-0" : "min-w-0 truncate",
          !step.settled && "step-shimmer",
        )}
      >
        {step.verb}
      </span>
      {step.target && <TargetChip target={step.target} />}
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

/**
 * A step's target as a monospace chip. A path keeps its file name in view and gives way from its
 * folders when space runs short; a command or query truncates at its end.
 */
function TargetChip(props: { target: string }) {
  const chip = "flex min-w-0 rounded-md bg-fill px-1.5 py-0.5 font-mono text-xs text-foreground";
  const slash = props.target.lastIndexOf("/");
  const path = slash > 0 && slash < props.target.length - 1 && !/\s/.test(props.target);
  if (!path)
    return (
      <code className={chip} title={props.target}>
        <span className="min-w-0 truncate">{props.target}</span>
      </code>
    );
  return (
    <code className={chip} title={props.target}>
      <span className="min-w-0 truncate">{props.target.slice(0, slash + 1)}</span>
      <span className="shrink-0">{props.target.slice(slash + 1)}</span>
    </code>
  );
}

export function ToolStep(props: React.ComponentProps<typeof ToolStepContent>) {
  return (
    <LocalBoundary label="this step">
      <ToolStepContent {...props} />
    </LocalBoundary>
  );
}
