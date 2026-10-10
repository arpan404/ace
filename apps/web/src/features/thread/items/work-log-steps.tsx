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
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { Suspense, useId, useState } from "react";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { DeferredMeasurementStep } from "./deferred-measurement.ts";
import { DeferredReviewNote } from "./deferred-review.ts";
import { MessageAttachments } from "@/components/attachment-message.tsx";
import { AssistantMessage } from "./messages.tsx";
import { StepDetail } from "./step-detail.tsx";
import { StepGroup, StepImages, useAceLog } from "./ace-steps.tsx";
import { ToolMarkIcon } from "./tool-mark.tsx";
import { useStepDisplay } from "./use-step-display.ts";

/*
 * A work log's rows, shown when it opens: each step as a quiet line that expands to its
 * detail, and what the agent said between steps as prose, in order. Loaded after first paint
 * (logs start collapsed), with the step wording.
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

/**
 * The open log's steps. ace's own steps read with what earlier ones said, the daemon's audit of
 * a computer-use action folds into its call, and consecutive steps on one app, site or device
 * collapse into one line.
 */
export function WorkLogSteps(props: {
  threadId: string;
  itemIds: readonly string[];
  panel: string;
}) {
  const log = useAceLog(props.threadId, props.itemIds);
  return (
    <ul id={props.panel} aria-label="Steps" className="fx-rise-in mt-0.5 mb-2 flex flex-col py-1">
      {log.rows.map((row) =>
        row.kind === "group" ? (
          <StepGroup key={row.key} group={row}>
            {row.ids.map((id) => (
              <ToolStep key={id} threadId={props.threadId} itemId={id} ace={log.contexts[id]} />
            ))}
          </StepGroup>
        ) : (
          <ToolStep
            key={row.id}
            threadId={props.threadId}
            itemId={row.id}
            ace={log.contexts[row.id]}
          />
        ),
      )}
    </ul>
  );
}

/**
 * One row of the work log. Expands to its output, diff or reasoning. ace's review of a step
 * sits right under that step; a smoothness measurement opens to its card.
 */
export function ToolStep(props: {
  threadId: string;
  itemId: string;
  ace?: AceToolContext | undefined;
}) {
  const data = useStepDisplay(props.threadId, props.itemId, props.ace);
  const item = data?.item;
  // What the agent said between two steps.
  if (item?.type === "message")
    return (
      <li className="py-1.5 pl-1.5">
        <AssistantMessage threadId={props.threadId} itemId={props.itemId} />
      </li>
    );
  if (item?.type === "notice" && reviewedInteraction(item))
    return (
      <li className="py-1 pl-1.5">
        <Suspense fallback={<p className="text-ui text-muted-foreground">{item.text}</p>}>
          <DeferredReviewNote.Component threadId={props.threadId} item={item} />
        </Suspense>
      </li>
    );
  const line = <StepLine threadId={props.threadId} data={data} />;
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

function StepLine(props: { threadId: string; data: ReturnType<typeof useStepDisplay> }) {
  const { data } = props;
  // A step shown while it waits for approval starts open.
  const [open, setOpen] = useState(data?.awaiting ?? false);
  const panel = useId();
  if (!data) return null;
  return (
    <li>
      <StepRow step={data.step} open={open} panel={panel} onToggle={() => setOpen(!open)} />
      {data.step.ace && data.step.ace.images.length > 0 && <StepImages view={data.step.ace} />}
      {data.item.type === "tool_call" &&
        data.item.call.detail.kind === "image" &&
        data.item.call.detail.attachment &&
        !open && (
          <MessageAttachments
            threadId={props.threadId}
            attachments={[data.item.call.detail.attachment]}
            className="mt-1 items-start pl-6"
          />
        )}
      {open && (
        <div id={panel} className="mt-1 mb-2 pl-6">
          <StepDetail item={data.item} threadId={props.threadId} ace={data.step.ace} />
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
      title={step.ace?.problem?.hint}
      onClick={props.onToggle}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent"
    >
      {!step.settled ? (
        <LiveWorkMark className="mx-px" />
      ) : step.ace ? (
        <ToolMarkIcon mark={step.ace.mark} fallback="row" />
      ) : (
        <Glyph aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
      )}
      <span className={step.target ? "shrink-0" : "min-w-0 truncate"}>{step.verb}</span>
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
