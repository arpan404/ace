import type { Item, ToolSurface } from "@ace/protocol";
import {
  groupSteps,
  thoughtLabel,
  thoughtMs,
  type GroupIcon,
  type GroupedSteps as Grouped,
  type StepFact,
  type StepGroup,
} from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import {
  readWorkLog,
  sameWorkLogReading,
  type WorkLogReading,
} from "@ace/ui-core/work-log-reading";
import {
  BrainIcon,
  ChatTeardropTextIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GlobeIcon,
  HammerIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlugIcon,
  RobotIcon,
  TerminalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { BrowserUseIcon, ComputerUseIcon } from "@/components/ace-icons.tsx";
import { memo, useCallback, useId, useMemo, useState } from "react";
import { OpenStepsContext, useGroupOpen, useOpenSteps, useStepOpen } from "./step-open.ts";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useAceLog } from "./ace-steps.tsx";
import { useStepItem, useStepItemsSelect } from "./step-items.ts";
import { ToolStep } from "./work-log-steps.tsx";
import { BackgroundStep, useBackgroundCalls } from "./background-step.tsx";
import { RailMark, StepRail } from "./step-rail.tsx";
import { LiveGroupTitle } from "./live-group-title.tsx";
import { useAnswerText } from "./answer-text.ts";
import { useRunEnded, useStreaming } from "../transcript/use-streaming.ts";
import { Button } from "@/components/ui/button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { StaticRow, TranscriptRow, pressableRowClass, rowDetailIndent } from "./transcript-row.tsx";

/*
 * A work log as one quiet flow: consecutive calls by one agent read as one sentence row with a
 * muted icon ("Edited 2 files, ran 1 command and thought once"), opening in place to their
 * steps; what the agent said between them is prose. While the turn works, the running group
 * shows its current step as its title (no second line for the step in flight), settling to
 * its sentence once done, or "Thinking" when no step is. Each step is read once per change
 * of that step, so streaming costs what changed, not the turn's length.
 */

/** The log's groups, regrouped from the first changed step only. */
function useGroups(steps: readonly StepFact[]): readonly StepGroup[] {
  // Remembers the facts it last grouped, apart from the grouping: an unchanged grouping comes back
  // as the same object, whose own facts may be an older (equal) array.
  const [state, setState] = useState<{ facts: readonly StepFact[]; grouped: Grouped }>(() => ({
    facts: steps,
    grouped: groupSteps(steps),
  }));
  if (state.facts === steps) return state.grouped.groups;
  const grouped = groupSteps(steps, state.grouped);
  setState({ facts: steps, grouped });
  return grouped.groups;
}

const nothing: WorkLogReading = { facts: [], surfaces: new Map(), retried: new Set() };

export function GroupedSteps(props: {
  threadId: string;
  itemIds: readonly string[];
  /** The turn still works: its last group keeps the step in flight in view. */
  live?: boolean | undefined;
  /** Surfaces the daemon resolved with the steps (their icon hashes), by item. */
  surfaces?: ReadonlyMap<string, ToolSurface> | undefined;
  /** Shown on the step rail (an opened "Worked for"), not in the plain flow. */
  rail?: boolean | undefined;
  id?: string | undefined;
}) {
  const ace = useAceLog(props.threadId, props.itemIds);
  // ace's own audits fold into the call they record; everything else may be a step.
  const shown = useMemo(
    () => (ace.hidden.size ? props.itemIds.filter((id) => !ace.hidden.has(id)) : props.itemIds),
    [ace.hidden, props.itemIds],
  );
  const calls = useBackgroundCalls(props.threadId, shown);
  const read = useCallback(
    (items: readonly (Item | undefined)[]) => readWorkLog(items, calls),
    [calls],
  );
  const log = useStepItemsSelect(props.threadId, shown, read, sameWorkLogReading) ?? nothing;
  const groups = useGroups(log.facts);
  const opened = useOpenSteps();
  const rows = groups.map((group, index) => (
    <GroupView
      key={group.key}
      threadId={props.threadId}
      group={group}
      live={!!props.live && index === groups.length - 1}
      contexts={ace.contexts}
      surfaces={props.surfaces}
      carried={log.surfaces}
      retried={log.retried}
      calls={calls}
    />
  ));
  return (
    <OpenStepsContext value={opened}>
      {props.rail ? (
        <StepRail id={props.id} label="Steps">
          {rows}
        </StepRail>
      ) : (
        <ul id={props.id} aria-label="Steps" className="flex flex-col">
          {rows}
        </ul>
      )}
    </OpenStepsContext>
  );
}

const groupIcons: Record<GroupIcon, PhosphorIcon> = {
  explore: MagnifyingGlassIcon,
  mixed: HammerIcon,
  edit: NotePencilIcon,
  command: TerminalIcon,
  computer: ComputerUseIcon,
  browser: BrowserUseIcon,
  fetch: GlobeIcon,
  websearch: GlobeIcon,
  read: FileTextIcon,
  search: MagnifyingGlassIcon,
  list: FolderSimpleIcon,
  plan: ListChecksIcon,
  spawn: RobotIcon,
  background: TerminalIcon,
  agent: RobotIcon,
  question: ChatTeardropTextIcon,
  tool: PlugIcon,
  think: BrainIcon,
};

/** The turn is working with no step in flight: the model is thinking, as a header like a running group. */
export function ThinkingRow() {
  return (
    <li className="relative">
      <RailMark state="running" />
      <StaticRow
        role="status"
        stepGroup
        lead={<Icon icon={BrainIcon} size={16} />}
        leadKind="thought"
        title={thoughtLabel(false, undefined)}
        titleClassName="step-shimmer"
      />
    </li>
  );
}

/** A thought's time changes as items follow it and as it finishes. */
const thoughtKeys: readonly ThreadKey[] = ["order", "thread"];

/**
 * What the agent thought, as one quiet row: "Thinking…" while it thinks, "Thought for 12s" once
 * done, the same height either way so nothing moves when it finishes. The thought itself opens
 * in place, as markdown, only when the reader asks for it.
 */
function ThoughtRow(props: { threadId: string; itemId: string }) {
  const item = useStepItem(props.threadId, props.itemId);
  const answer = useAnswerText(item);
  const streaming = useStreaming(props.threadId, item);
  const ended = useRunEnded(props.threadId, item);
  const [toggled, setOpen] = useStepOpen(props.itemId);
  const panel = useId();
  const open = toggled ?? false;
  const readTook = useCallback(
    (reader: ThreadReader) => thoughtMs(reader, props.itemId),
    [props.itemId],
  );
  const took = useThread(props.threadId, thoughtKeys, readTook, Object.is);
  if (item?.type !== "reasoning") return null;
  const text = answer.text.trim();
  // A thought whose turn is over is finished, whatever its stream last said.
  const done = item.complete || ended;
  // Still thinking with no words yet: the same header as a thinking turn with no step in flight.
  if (!done && !text) return <ThinkingRow />;
  return (
    <li className="relative min-w-0">
      <RailMark state={done ? "done" : "running"} />
      <TranscriptRow
        expanded={open}
        stepGroup
        controls={panel}
        onToggle={() => setOpen(!open)}
        lead={<Icon icon={BrainIcon} size={16} />}
        leadKind="thought"
        title={thoughtLabel(done, took)}
        titleClassName={done ? undefined : "step-shimmer"}
      />
      {open && (
        <div
          id={panel}
          className={cn(
            "min-w-0 pb-1.5 font-prose text-ui leading-relaxed wrap-break-word text-muted-foreground",
            rowDetailIndent,
          )}
        >
          <Prose
            text={text}
            thread={{ threadId: props.threadId, itemId: props.itemId }}
            stream={`${props.threadId}/${props.itemId}`}
            streaming={streaming}
          />
        </div>
      )}
      {answer.problem && (
        <p role="alert" className={cn("text-ui text-muted-foreground", rowDetailIndent)}>
          {answer.problem}{" "}
          {answer.retryable && (
            <Button size="sm" onClick={answer.load}>
              Try again
            </Button>
          )}
        </p>
      )}
    </li>
  );
}

const GroupView = memo(function GroupView(props: {
  threadId: string;
  group: StepGroup;
  live: boolean;
  contexts: Readonly<Record<string, AceToolContext>>;
  surfaces: ReadonlyMap<string, ToolSurface> | undefined;
  carried: ReadonlyMap<string, ToolSurface>;
  retried: ReadonlySet<string>;
  calls: ReadonlyMap<string, string>;
}) {
  const { group } = props;
  const [open, setOpen] = useGroupOpen(group.key, group.ids);
  const panel = useId();
  const step = (id: string) => (
    <GroupStep
      key={id}
      threadId={props.threadId}
      itemId={id}
      ace={props.contexts[id]}
      retried={props.retried.has(id)}
      surface={props.surfaces?.get(id) ?? props.carried.get(id)}
    />
  );
  // Commands left running in the background: their task's line, or one group of them.
  if (group.icon === "background")
    return <BackgroundStep threadId={props.threadId} itemIds={group.ids} calls={props.calls} />;
  if (group.single && group.icon === "think")
    return <ThoughtRow threadId={props.threadId} itemId={group.key} />;
  if (group.single) return step(group.key);
  const active = group.active ?? group.newest;
  const runningLive = props.live && group.running;
  return (
    <li className="relative">
      <RailMark state={group.running ? "running" : group.failed ? "failed" : "done"} />
      {runningLive ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          data-step-group=""
          title={group.summary}
          onClick={() => setOpen(!open)}
          className={cn(pressableRowClass, "text-muted-foreground")}
        >
          <LiveGroupTitle
            threadId={props.threadId}
            itemId={active}
            ace={props.contexts[active]}
            surface={props.surfaces?.get(active) ?? props.carried.get(active)}
            count={group.ids.length}
          />
        </button>
      ) : (
        <TranscriptRow
          expanded={open}
          stepGroup
          controls={panel}
          onToggle={() => setOpen(!open)}
          lead={<Icon icon={groupIcons[group.icon]} size={16} />}
          leadKind={group.icon}
          title={
            <>
              {group.sentence}
              {group.failed > 0 && (
                <span className="text-status-failed"> · {group.failed} failed</span>
              )}
            </>
          }
        />
      )}
      {open && (
        <StepRail id={panel} label={group.summary}>
          {group.ids.map(step)}
        </StepRail>
      )}
    </li>
  );
});

function GroupStep(props: {
  threadId: string;
  itemId: string;
  ace?: AceToolContext | undefined;
  retried?: boolean | undefined;
  surface?: ToolSurface | undefined;
}) {
  const item = useStepItem(props.threadId, props.itemId);
  if (item?.type === "reasoning")
    return <ThoughtRow threadId={props.threadId} itemId={props.itemId} />;
  return <ToolStep {...props} />;
}
