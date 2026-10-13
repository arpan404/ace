import { ToolSurface, type Item, type TurnStep } from "@ace/protocol";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Block } from "../transcript/blocks.ts";
import { useTurnSteps } from "../lib/turn-steps.ts";
import { StepItems } from "./step-items.ts";
import { GroupedSteps } from "./step-groups-view.tsx";
import { StepsSkeleton } from "./work-log-view.tsx";

/*
 * An opened "Worked for" log. A completed turn's steps come from the daemon (`turn.steps`) as
 * it opens, with a skeleton until they arrive, and leave memory soon after it closes; a log the
 * daemon can't name a turn for shows the steps the thread has loaded, in the turn's order.
 * Loaded after first paint.
 */

type WorkBlock = Extract<Block, { kind: "work" }>;

function fromDaemon(steps: readonly TurnStep[], answers: ReadonlySet<string>) {
  const items = new Map<string, Item>();
  const surfaces = new Map<string, ToolSurface>();
  const ids: string[] = [];
  for (const step of steps) {
    items.set(step.item.id, step.item);
    // A surface this build doesn't know is just not drawn.
    const surface = ToolSurface.safeParse(step.surface);
    if (step.surface && surface.success) surfaces.set(step.item.id, surface.data);
    if (!answers.has(step.item.id)) ids.push(step.item.id);
  }
  return { items, surfaces, ids };
}

/** What the thread has loaded of the turn, in its order: the steps, what was said between. */
function loadedOrder(block: WorkBlock): string[] {
  const ids: string[] = [];
  for (const inner of block.folded ?? [block])
    switch (inner.kind) {
      case "work":
      case "subagents":
        ids.push(...inner.itemIds);
        break;
      case "message":
        ids.push(inner.itemId);
        break;
      case "background":
        ids.push(...inner.itemIds);
        break;
      default:
        break;
    }
  return [...new Set(ids)];
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
  const completed = block.outcome === "completed" && props.ordinal !== undefined;
  const { entry, retry, loadMore } = useTurnSteps(
    props.threadId,
    completed ? props.ordinal : undefined,
    true,
    props.endSeq,
  );
  const answers = useMemo(() => new Set(block.answerIds), [block.answerIds]);
  const ready = entry && (entry.state === "ready" || entry.steps.length > 0);
  const fetched = useMemo(
    () => (ready && entry ? fromDaemon(entry.steps, answers) : undefined),
    [ready, entry, answers],
  );
  const loaded = useMemo(() => loadedOrder(block), [block]);
  if (completed && entry?.state === "failed" && !entry.steps.length)
    return (
      <p role="alert" className="flex items-center gap-2 py-1 text-ui text-muted-foreground">
        Couldn't load these steps.
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      </p>
    );
  if (completed && !fetched) return <StepsSkeleton />;
  if (fetched) {
    if (!fetched.ids.length)
      return <p className="py-1 text-ui text-subtle-foreground">No steps recorded.</p>;
    return (
      <StepItems value={fetched.items}>
        <GroupedSteps
          threadId={props.threadId}
          itemIds={fetched.ids}
          surfaces={fetched.surfaces}
          id={props.panel}
          rail
        />
        {entry?.more && (
          <Button variant="ghost" size="sm" disabled={entry.state === "loading"} onClick={loadMore}>
            Load more steps
          </Button>
        )}
      </StepItems>
    );
  }
  return <GroupedSteps threadId={props.threadId} itemIds={loaded} id={props.panel} rail />;
}
