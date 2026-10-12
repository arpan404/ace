import { toolSurfaces } from "@ace/projection";
import type { Item, ToolSurface } from "@ace/protocol";
import {
  groupSteps,
  retriedStepIds,
  sameFact,
  stepFact,
  type GroupedSteps as Grouped,
  type StepFact,
  type StepGroup,
} from "@ace/ui-core";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, useId, useMemo, useState } from "react";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { useAceLog } from "./ace-steps.tsx";
import { useStepItemsSelect } from "./step-items.ts";
import { ToolStep } from "./work-log-steps.tsx";

/*
 * A work log's steps, grouped (`groupSteps`): consecutive calls by one agent fold into one
 * summary row, the agent's words between them stand alone. While the turn works, the newest
 * step of the last group stays in view under its summary, shimmering; the rest sit behind the
 * toggle. Appending a step regroups only the last group, so streaming costs what changed.
 */

const sameFacts = (a: readonly StepFact[], b: readonly StepFact[]) =>
  a.length === b.length && a.every((fact, index) => sameFact(fact, b[index] ?? fact));

function readFacts(items: readonly (Item | undefined)[]): StepFact[] {
  const loaded = items.filter((item): item is Item => item !== undefined);
  const retried = retriedStepIds(loaded);
  return loaded.map((item) => stepFact(item, retried));
}

const surfaceKey = (surface: ToolSurface | undefined) =>
  surface ? `${surface.kind}:${surface.icon ? JSON.stringify(surface.icon) : ""}` : "";
function readSurfaces(items: readonly (Item | undefined)[]): ReadonlyMap<string, ToolSurface> {
  return toolSurfaces(items.filter((item): item is Item => item !== undefined));
}
const sameSurfaces = (a: ReadonlyMap<string, ToolSurface>, b: ReadonlyMap<string, ToolSurface>) =>
  a.size === b.size &&
  [...a].every(([id, surface]) => surfaceKey(b.get(id)) === surfaceKey(surface));

/** The log's groups, regrouped from the first changed step only. */
function useGroups(facts: readonly StepFact[]): readonly StepGroup[] {
  const [grouped, setGrouped] = useState<Grouped>(() => groupSteps(facts));
  if (grouped.facts === facts) return grouped.groups;
  const next = groupSteps(facts, grouped);
  setGrouped(next);
  return next.groups;
}

const none: readonly StepFact[] = [];
const noIds: ReadonlySet<string> = new Set();
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));
const noSurfaces: ReadonlyMap<string, ToolSurface> = new Map();

export function GroupedSteps(props: {
  threadId: string;
  itemIds: readonly string[];
  /** The turn still works: the last group keeps its newest step in view. */
  live?: boolean | undefined;
  /** Surfaces the daemon resolved with the steps (their icon hashes), by item. */
  surfaces?: ReadonlyMap<string, ToolSurface> | undefined;
  id?: string | undefined;
}) {
  const log = useAceLog(props.threadId, props.itemIds);
  // ace's own audits fold into the call they record; everything else is a step.
  const shown = useMemo(
    () => log.rows.flatMap((row) => (row.kind === "group" ? row.ids : [row.id])),
    [log.rows],
  );
  const facts = useStepItemsSelect(props.threadId, shown, readFacts, sameFacts) ?? none;
  const carried =
    useStepItemsSelect(props.threadId, shown, readSurfaces, sameSurfaces) ?? noSurfaces;
  const groups = useGroups(facts);
  const retried = useStepItemsSelect(props.threadId, shown, retriedStepIds, sameIds) ?? noIds;
  return (
    <ul id={props.id} aria-label="Steps" className="flex flex-col">
      {groups.map((group, index) => (
        <GroupView
          key={group.key}
          threadId={props.threadId}
          group={group}
          live={!!props.live && index === groups.length - 1}
          contexts={log.contexts}
          surfaces={props.surfaces ?? carried}
          fallback={carried}
          retried={retried}
        />
      ))}
    </ul>
  );
}

const GroupView = memo(function GroupView(props: {
  threadId: string;
  group: StepGroup;
  live: boolean;
  contexts: Readonly<Record<string, AceToolContext>>;
  surfaces: ReadonlyMap<string, ToolSurface>;
  fallback: ReadonlyMap<string, ToolSurface>;
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
      surface={props.surfaces.get(id) ?? props.fallback.get(id)}
    />
  );
  if (group.single) return step(group.key);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group flex h-7 pointer-coarse:min-h-10 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground"
      >
        {group.running && !open && !props.live ? (
          <LiveWorkMark className="mx-px" />
        ) : (
          <CaretRightIcon
            aria-hidden
            size={14}
            className={cn(
              "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
              open && "rotate-90",
            )}
          />
        )}
        <span className="min-w-0 truncate">
          {group.summary.split(" · ").map((part, index) => (
            <span key={part} className={cn(part.endsWith(" failed") && "text-status-failed")}>
              {index ? " · " : ""}
              {part}
            </span>
          ))}
        </span>
      </button>
      {open ? (
        <ul id={panel} aria-label={group.summary} className="fx-rise-in flex flex-col">
          {group.ids.map(step)}
        </ul>
      ) : (
        props.live && (
          <ul id={panel} aria-label="Newest step" className="flex flex-col">
            {step(group.newest)}
          </ul>
        )
      )}
    </li>
  );
});
