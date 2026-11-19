import { useThreadField } from "@ace/client-react/thread-field";
import { threadRootAgentId } from "@/lib/thread-fields.ts";
import { ToolSurface, type Item, type TurnStep } from "@ace/protocol";
import { momentOf, placeMoments, type MomentSegment } from "@ace/ui-core";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Block } from "../transcript/blocks.ts";
import { useTurnSteps } from "../lib/turn-steps.ts";
import { StepItems } from "./step-items.ts";
import { GroupedSteps } from "./step-groups-view.tsx";
import { StepsSkeleton } from "./work-log-view.tsx";
import { MomentRow } from "./moment-row.tsx";

/*
 * An opened "Worked for" log. A completed turn's steps come from the daemon (`turn.steps`) as
 * it opens, with a skeleton until they arrive, and leave memory soon after it closes; a log the
 * daemon can't name a turn for shows the steps the thread has loaded, in the turn's order. The
 * turn's moments (a restart, a limit's wait, delegated work coming back) read as one quiet row
 * each where they happened, between its steps. Loaded after first paint.
 */

type WorkBlock = Extract<Block, { kind: "work" }>;
type Moment = Extract<Block, { kind: "moment" }>;
type Segment = MomentSegment<Moment>;

function fromDaemon(
  block: WorkBlock,
  steps: readonly TurnStep[],
  answers: ReadonlySet<string>,
  owner: string | undefined,
) {
  const items = new Map<string, Item>();
  const surfaces = new Map<string, ToolSurface>();
  const shown: { id: string; at: number }[] = [];
  for (const step of steps) {
    if (owner !== undefined && step.item.agentId !== owner) continue;
    // A moment's own items read as its row, placed below, never as steps.
    if (momentOf(step.item)) continue;
    items.set(step.item.id, step.item);
    // A surface this build doesn't know is just not drawn.
    const surface = ToolSurface.safeParse(step.surface);
    if (step.surface && surface.success) surfaces.set(step.item.id, surface.data);
    if (!answers.has(step.item.id)) shown.push({ id: step.item.id, at: step.item.createdAt });
  }
  const segments = placeMoments(shown, momentsOf(block));
  return { items, surfaces, segments, empty: !segments.length };
}

const momentsOf = (block: WorkBlock) =>
  (block.folded ?? []).filter((inner): inner is Moment => inner.kind === "moment");

/** What the thread has loaded of the turn, in its order: the steps, what was said between. */
function loadedOrder(block: WorkBlock): Segment[] {
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let open: string[] | undefined;
  const add = (ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!open) segments.push({ kind: "steps", ids: (open = []) });
      open.push(id);
    }
  };
  for (const inner of block.folded ?? [block])
    switch (inner.kind) {
      case "work":
      case "subagents":
        add(inner.itemIds);
        break;
      case "message":
        add([inner.itemId]);
        break;
      case "moment":
        open = undefined;
        segments.push({ kind: "moment", moment: inner });
        break;
      default:
        break;
    }
  return segments;
}

/** The opened log: its steps on the rail, with each moment's row between them where it happened. */
function Segments(props: {
  threadId: string;
  segments: readonly Segment[];
  surfaces?: ReadonlyMap<string, ToolSurface> | undefined;
  panel: string;
}) {
  const [only] = props.segments;
  if (props.segments.length === 1 && only?.kind === "steps")
    return (
      <GroupedSteps
        threadId={props.threadId}
        itemIds={only.ids}
        surfaces={props.surfaces}
        id={props.panel}
        rail
      />
    );
  return (
    <div id={props.panel} className="flex flex-col">
      {props.segments.map((segment) =>
        segment.kind === "steps" ? (
          <GroupedSteps
            key={`steps:${segment.ids[0] ?? ""}`}
            threadId={props.threadId}
            itemIds={segment.ids}
            surfaces={props.surfaces}
            rail
          />
        ) : (
          // On the rail's line, so the log reads as one rail with the row on it.
          <div key={segment.moment.key} className="ml-1.5 border-l border-border pl-4.5">
            <MomentRow
              threadId={props.threadId}
              moment={segment.moment.moment}
              itemIds={segment.moment.itemIds}
              since={segment.moment.since}
            />
          </div>
        ),
      )}
    </div>
  );
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
  const owner = useThreadField(props.threadId, threadRootAgentId);
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
    () => (ready && entry ? fromDaemon(block, entry.steps, answers, owner) : undefined),
    [block, ready, entry, answers, owner],
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
    return (
      <StepItems value={fetched.items}>
        {!fetched.empty ? (
          <Segments
            threadId={props.threadId}
            segments={fetched.segments}
            surfaces={fetched.surfaces}
            panel={props.panel}
          />
        ) : (
          <p className="py-1 text-ui text-subtle-foreground">No steps recorded.</p>
        )}
        {entry?.more && (
          <Button variant="ghost" size="sm" disabled={entry.state === "loading"} onClick={loadMore}>
            Load more steps
          </Button>
        )}
      </StepItems>
    );
  }
  return <Segments threadId={props.threadId} segments={loaded} panel={props.panel} />;
}
