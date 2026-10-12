import { toolSurface } from "@ace/projection";
import type { Item, ToolSurface } from "@ace/protocol";
import {
  groupSteps,
  retriedStepIds,
  sameFact,
  stepFact,
  type GroupIcon,
  type GroupedSteps as Grouped,
  type StepFact,
  type StepGroup,
} from "@ace/ui-core";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import {
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  HammerIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  NotePencilIcon,
  PlugIcon,
  RobotIcon,
  TerminalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { memo, useId, useMemo, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useAceLog } from "./ace-steps.tsx";
import { useStepItem, useStepItemsSelect } from "./step-items.ts";
import { ToolStep } from "./work-log-steps.tsx";
import { RailMark, StepRail } from "./step-rail.tsx";

/*
 * A work log as one quiet flow: consecutive calls by one agent read as one sentence row with a
 * muted icon ("Ran 5 commands and read 1 file"), opening in place to their steps; what the agent
 * said between them is prose; what it thought is a muted row of its own. While the turn works,
 * the step in flight closes the flow, shimmering, or "Thinking" when no step is. Each step is
 * read once per change of that step, so streaming costs what changed, not the turn's length.
 */

/** Per item object: what it counts as, and the surface it drove. Items change by replacement. */
const facts = new WeakMap<Item, StepFact | null>();
const surfaces = new WeakMap<Item, ToolSurface | null>();

function factOf(item: Item): StepFact | undefined {
  let fact = facts.get(item);
  if (fact === undefined) {
    fact = stepFact(item) ?? null;
    facts.set(item, fact);
  }
  return fact ?? undefined;
}

function surfaceOf(item: Item): ToolSurface | undefined {
  let surface = surfaces.get(item);
  if (surface === undefined) {
    surface = item.type === "tool_call" ? (toolSurface(item.call) ?? null) : null;
    surfaces.set(item, surface);
  }
  return surface ?? undefined;
}

const noIds: ReadonlySet<string> = new Set();

interface LogReading {
  facts: readonly StepFact[];
  /** Each step's surface, a URL-less browser step on the site its agent was last on. */
  surfaces: ReadonlyMap<string, ToolSurface>;
  /** Failed steps a later step ran again with success: not shown as failed. */
  retried: ReadonlySet<string>;
}

function readLog(items: readonly (Item | undefined)[]): LogReading {
  const loaded = items.filter((item): item is Item => item !== undefined);
  // Only a log with a failure looks for retries: the common case reads each item once.
  const retried = loaded.some((item) => factOf(item)?.failed) ? retriedStepIds(loaded) : undefined;
  const out: StepFact[] = [];
  const shown = new Map<string, ToolSurface>();
  const sites = new Map<string, string>();
  for (const item of loaded) {
    const fact = factOf(item);
    if (!fact) continue;
    out.push(retried?.has(item.id) ? { ...fact, failed: false } : fact);
    const surface = surfaceOf(item);
    if (!surface) continue;
    const agent = item.agentId ?? "";
    const carried = sites.get(agent);
    const drawn =
      surface.kind === "browser" && !surface.icon && carried
        ? { ...surface, icon: { kind: "site" as const, origin: carried } }
        : surface;
    if (drawn.icon?.kind === "site") sites.set(agent, drawn.icon.origin);
    shown.set(item.id, drawn);
  }
  return { facts: out, surfaces: shown, retried: retried ?? noIds };
}

const sameReading = (a: LogReading, b: LogReading) =>
  a.retried.size === b.retried.size &&
  [...a.retried].every((id) => b.retried.has(id)) &&
  a.facts.length === b.facts.length &&
  a.facts.every((fact, index) => sameFact(fact, b.facts[index] ?? fact)) &&
  a.surfaces.size === b.surfaces.size &&
  [...a.surfaces].every(([id, surface]) => {
    const other = b.surfaces.get(id);
    return (
      other?.kind === surface.kind &&
      JSON.stringify(other.icon) === JSON.stringify(surface.icon) &&
      other.iconRef === surface.iconRef
    );
  });

/** The log's groups, regrouped from the first changed step only. */
function useGroups(steps: readonly StepFact[]): readonly StepGroup[] {
  const [grouped, setGrouped] = useState<Grouped>(() => groupSteps(steps));
  if (grouped.facts === steps) return grouped.groups;
  const next = groupSteps(steps, grouped);
  setGrouped(next);
  return next.groups;
}

const nothing: LogReading = { facts: [], surfaces: new Map(), retried: new Set() };

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
  const log = useStepItemsSelect(props.threadId, shown, readLog, sameReading) ?? nothing;
  const groups = useGroups(log.facts);
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
    />
  ));
  return props.rail ? (
    <StepRail id={props.id} label="Steps">
      {rows}
    </StepRail>
  ) : (
    <ul id={props.id} aria-label="Steps" className="flex flex-col">
      {rows}
    </ul>
  );
}

const groupIcons: Record<GroupIcon, PhosphorIcon> = {
  explore: MagnifyingGlassIcon,
  mixed: HammerIcon,
  edit: NotePencilIcon,
  command: TerminalIcon,
  computer: MonitorIcon,
  browser: GlobeIcon,
  fetch: GlobeIcon,
  websearch: GlobeIcon,
  read: FileTextIcon,
  search: MagnifyingGlassIcon,
  list: MagnifyingGlassIcon,
  plan: ListChecksIcon,
  spawn: RobotIcon,
  agent: RobotIcon,
  tool: PlugIcon,
  think: BrainIcon,
};

const row = "flex min-h-8 w-full min-w-0 items-center gap-2.5 text-left text-ui";

/** The turn is working with no step in flight: the model is thinking. */
export function ThinkingRow() {
  return (
    <li role="status" className={cn(row, "text-muted-foreground")}>
      <Icon icon={BrainIcon} size={16} className="text-subtle-foreground" />
      <span className="step-shimmer">Thinking</span>
    </li>
  );
}

/** What the agent thought, as a muted row of its own; "Thinking" while it still thinks. */
function ThoughtRow(props: { threadId: string; itemId: string }) {
  const item = useStepItem(props.threadId, props.itemId);
  const [open, setOpen] = useState(false);
  if (item?.type !== "reasoning") return null;
  const text = item.text.trim();
  return (
    <li className="relative flex min-h-8 min-w-0 items-start gap-2.5 py-1.5 text-ui text-muted-foreground">
      <RailMark state={item.complete ? "done" : "running"} />
      <Icon icon={BrainIcon} size={16} className="mt-0.5 text-subtle-foreground" />
      {!item.complete && !text ? (
        <span className="step-shimmer">Thinking</span>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            "min-w-0 text-left leading-relaxed whitespace-pre-wrap",
            !open && "line-clamp-3",
            !item.complete && "step-shimmer",
          )}
        >
          {text}
        </button>
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
}) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const panel = useId();
  const step = (id: string) => (
    <ToolStep
      key={id}
      threadId={props.threadId}
      itemId={id}
      ace={props.contexts[id]}
      retried={props.retried.has(id)}
      surface={props.surfaces?.get(id) ?? props.carried.get(id)}
    />
  );
  if (group.single && group.icon === "think")
    return <ThoughtRow threadId={props.threadId} itemId={group.key} />;
  if (group.single) return step(group.key);
  const [sentence, failed] = group.summary.split(" · ");
  return (
    <li className="relative">
      <RailMark state={group.running ? "running" : group.failed ? "failed" : "done"} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        data-step-group=""
        onClick={() => setOpen(!open)}
        className={cn(
          row,
          "text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground",
        )}
      >
        <Icon icon={groupIcons[group.icon]} size={16} className="text-subtle-foreground" />
        <span className="min-w-0 truncate">
          {sentence}
          {failed && <span className="text-status-failed"> · {failed}</span>}
        </span>
      </button>
      {open ? (
        <StepRail id={panel} label={group.summary}>
          {group.ids.map(step)}
        </StepRail>
      ) : (
        props.live &&
        group.running && (
          <ul id={panel} aria-label="Step in flight" className="flex flex-col">
            {step(group.newest)}
          </ul>
        )
      )}
    </li>
  );
});
