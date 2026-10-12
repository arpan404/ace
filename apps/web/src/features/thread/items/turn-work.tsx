import type { Item, ToolSurface, TurnStep } from "@ace/protocol";
import { useMemo } from "react";
import { blockItems, type Block } from "../transcript/blocks.ts";
import { useTurnSteps } from "../lib/turn-steps.ts";
import { StepItems } from "./step-items.ts";
import { GroupedSteps } from "./step-groups-view.tsx";
import { StepsSkeleton } from "./work-log-view.tsx";

/*
 * An opened "Worked for" log. A completed turn's steps come from the daemon (`turn.steps`) as
 * it opens, with a skeleton until they arrive, and leave memory soon after it closes; a log the
 * daemon can't name a turn for shows the steps the thread has loaded. Loaded after first paint.
 */

type WorkBlock = Extract<Block, { kind: "work" }>;

/** Shown in the log: the turn's work, never its ask, its answer, an error or bookkeeping. */
function inLog(item: Item, answerId: string | undefined): boolean {
  if (item.id === answerId) return false;
  switch (item.type) {
    case "message":
      return item.role === "assistant" && !item.synthetic;
    case "notice":
      return item.level !== "error";
    case "tool_call":
    case "reasoning":
      return true;
    default:
      return false;
  }
}

function fromDaemon(steps: readonly TurnStep[], answerId: string | undefined) {
  const items = new Map<string, Item>();
  const surfaces = new Map<string, ToolSurface>();
  const ids: string[] = [];
  for (const step of steps) {
    items.set(step.item.id, step.item);
    if (step.surface) surfaces.set(step.item.id, step.surface);
    if (inLog(step.item, answerId)) ids.push(step.item.id);
  }
  return { items, surfaces, ids };
}

export function TurnWork(props: {
  threadId: string;
  block: WorkBlock;
  ordinal: number | undefined;
  /** The turn's end from its summary: a read older than it is read again. */
  endSeq: number | undefined;
  panel: string;
}) {
  const { block } = props;
  const completed = block.outcome === "completed";
  const entry = useTurnSteps(
    props.threadId,
    completed ? props.ordinal : undefined,
    true,
    props.endSeq,
  );
  const fetched = useMemo(
    () => (entry?.steps.length ? fromDaemon(entry.steps, block.answerId) : undefined),
    [entry, block.answerId],
  );
  const loaded = useMemo(() => [...new Set(blockItems(block))], [block]);
  if (completed && props.ordinal !== undefined && !fetched && entry?.state !== "failed")
    return <StepsSkeleton />;
  if (fetched)
    return (
      <StepItems value={fetched.items}>
        <GroupedSteps
          threadId={props.threadId}
          itemIds={fetched.ids}
          surfaces={fetched.surfaces}
          id={props.panel}
        />
      </StepItems>
    );
  return <GroupedSteps threadId={props.threadId} itemIds={loaded} id={props.panel} />;
}
