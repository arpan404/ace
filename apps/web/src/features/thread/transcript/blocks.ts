import type { Interaction, Item } from "@ace/protocol";
import { reviewedInteraction } from "@ace/ui-core";

/**
 * The transcript reads like a document: between two messages, all tool work collapses into one
 * "Worked for" line and all spawns into one "Started N subagents" line (subagents' own work
 * interleaves with the parent's, so these are per stretch, not per run of adjacent items), and a
 * changed-files card follows the answer that comes after edits. Blocks depend only on item order, item types and kinds, and which
 * calls started background tasks, all of which are fixed once an item exists, so a streaming
 * delta never regroups the transcript.
 *
 * Contract C-B (UX audit): `question` and `event` blocks are rendered by the step and event
 * renderers (`items/`); the transcript only decides where they sit.
 */
export type Block =
  | { kind: "user"; key: string; itemId: string }
  | { kind: "message"; key: string; itemId: string }
  | { kind: "work"; key: string; itemIds: string[] }
  | { kind: "subagents"; key: string; itemIds: string[] }
  | { kind: "background"; key: string; itemId: string; taskId: string }
  | { kind: "files"; key: string; itemIds: string[] }
  | { kind: "item"; key: string; itemId: string }
  /**
   * A question the agent asked the person, where it was asked: pending or answered, never
   * folded into a work log. `itemId` is the tool call it was asked from (its `ask_user` step,
   * which the block replaces), when that call is loaded.
   */
  | { kind: "question"; key: string; interactionId: string; itemId?: string | undefined }
  /**
   * A message ace or the provider injected rather than the person typed (synthetic today; the
   * message `origin` once it lands): a quiet event, never a bubble.
   */
  | { kind: "event"; key: string; itemId: string }
  /**
   * How a turn that didn't complete ended: "Turn failed" with its reason, or "Stopped". `runId`
   * is the root turn's run, when known; `askId` the person's message that started it.
   */
  | { kind: "end"; key: string; runId: string | undefined; askId: string | undefined };

/** Interactions shown as their own transcript block where they were asked. */
const inlineKinds = new Set<Interaction["request"]["kind"]>(["question"]);

/** Whether an interaction renders as a transcript block (else it waits in the live footer). */
export function isInlineInteraction(interaction: Pick<Interaction, "request">): boolean {
  return inlineKinds.has(interaction.request.kind);
}

export interface BlockSource {
  order: readonly string[];
  item(id: string): Item | undefined;
  /** Tool call id → background task id, for calls that outlived their turn. */
  background: ReadonlyMap<string, string>;
  /** Interactions that render inline (questions), oldest first. */
  questions?: readonly Pick<Interaction, "id" | "toolCallId" | "createdAt">[];
  /** The turn (the root agent's run) an item belongs to, where known. */
  turnOf?(itemId: string): string | undefined;
  /** How a turn ended; undefined while it runs or when unknown. */
  turnEnded?(turnId: string): TurnEnding | undefined;
  /** The tool call an interaction was raised from, for ace's review notices. */
  reviewedCall?(interactionId: string): string | undefined;
  /** The agent stopped or failed in a turn none of whose output is loaded. */
  stoppedTail?: boolean;
}

const editKinds = new Set(["file.edit", "file.write", "file.delete", "file.move"]);

/**
 * Where each inline interaction sits: after the item it was asked from, else after the last
 * item that existed when it was asked. Interactions older than the loaded window are left out.
 */
function anchorQuestions(source: BlockSource): Map<string, string[]> {
  const anchors = new Map<string, string[]>();
  const questions = source.questions ?? [];
  if (!questions.length || !source.order.length) return anchors;
  const loaded = new Set(source.order);
  const firstAt = source.item(source.order[0] ?? "")?.createdAt ?? Number.POSITIVE_INFINITY;
  for (const question of questions) {
    let anchor: string | undefined;
    if (question.toolCallId && loaded.has(question.toolCallId)) anchor = question.toolCallId;
    else if (question.createdAt >= firstAt)
      for (let index = source.order.length - 1; index >= 0; index--) {
        const id = source.order[index] ?? "";
        if ((source.item(id)?.createdAt ?? Number.POSITIVE_INFINITY) <= question.createdAt) {
          anchor = id;
          break;
        }
      }
    if (anchor === undefined) continue;
    const list = anchors.get(anchor);
    if (list) list.push(question.id);
    else anchors.set(anchor, [question.id]);
  }
  return anchors;
}

/** How a turn ended, once it has. */
export type TurnEnding = "completed" | "interrupted" | "failed";

/** What the blocks remember of one turn while building. */
interface TurnMark {
  /** The person's message that started it. */
  askId: string | undefined;
  edits: string[];
  /** Index of its last assistant message's block, and of its last block. */
  lastMessage: number;
  lastBlock: number;
}

/**
 * The transcript's blocks. A stretch of work (one "Worked for" log, one "Started N subagents"
 * line) runs until the agent speaks, the person writes or the agent asks them something, and
 * never across turns; notices, injected messages and other events show inline without ending
 * it. Once a turn has ended, one changed-files card follows its last answer, and a turn that
 * failed or was stopped ends with an `end` block.
 */
export function buildBlocks(source: BlockSource): Block[] {
  const blocks: Block[] = [];
  const anchors = anchorQuestions(source);
  const turns = new Map<string, TurnMark>();
  // The work and spawn groups of the stretch since the last message; a message ends it.
  let stretch: Partial<Record<"work" | "subagents", { itemIds: string[]; at: number }>> = {};
  const groupOf = new Map<string, { itemIds: string[]; at: number }>();
  let turnId: string | undefined;
  let askId: string | undefined;
  let mark: TurnMark | undefined;
  const placed = (index: number, message = false) => {
    if (!mark) return;
    mark.lastBlock = Math.max(mark.lastBlock, index);
    if (message) mark.lastMessage = index;
  };
  const group = (kind: "work" | "subagents", id: string) => {
    let open = stretch[kind];
    if (!open) {
      const itemIds: string[] = [];
      open = stretch[kind] = {
        itemIds,
        at: blocks.push({ kind, key: `${kind}:${id}`, itemIds }) - 1,
      };
    }
    open.itemIds.push(id);
    if (kind === "work") groupOf.set(id, open);
    placed(open.at);
  };
  const close = () => {
    stretch = {};
  };
  const push = (block: Block, closes: boolean, message = false) => {
    blocks.push(block);
    placed(blocks.length - 1, message);
    if (closes) close();
  };
  const reviewsPlaced = new Map<string, number>();
  for (const id of source.order) {
    const item = source.item(id);
    if (!item) continue;
    const person = item.type === "message" && item.role === "user" && !item.synthetic;
    if (person) {
      askId = id;
      // The person's message belongs to the turn that answers it.
      mark = undefined;
      turnId = undefined;
    } else {
      const known = source.turnOf?.(id) ?? turnId ?? (askId === undefined ? "" : `ask:${askId}`);
      if (known !== turnId) {
        if (turnId !== undefined) close();
        turnId = known;
        mark = turns.get(known);
        if (!mark) turns.set(known, (mark = { askId, edits: [], lastMessage: -1, lastBlock: -1 }));
      }
    }
    const asked = anchors.get(id);
    // A question's own step: the question block stands in for it.
    const replaced =
      !!asked && item.type === "tool_call" && item.call.detail.kind === "ask_user" ? id : undefined;
    if (!replaced)
      switch (item.type) {
        case "message":
          if (item.synthetic) push({ kind: "event", key: id, itemId: id }, false);
          else if (person) push({ kind: "user", key: id, itemId: id }, true);
          else push({ kind: "message", key: id, itemId: id }, true, true);
          break;
        case "tool_call": {
          const taskId = source.background.get(id);
          if (taskId !== undefined)
            push({ kind: "background", key: id, itemId: id, taskId }, false);
          else if (item.call.kind === "agent.spawn") group("subagents", id);
          else {
            group("work", id);
            if (editKinds.has(item.call.kind)) mark?.edits.push(id);
          }
          break;
        }
        case "reasoning":
          group("work", id);
          break;
        case "notice": {
          // Output or a review of a step joins that step's log, right after the step.
          const reviewed = reviewedInteraction(item);
          const callId = item.toolCallId ?? (reviewed && source.reviewedCall?.(reviewed));
          const host = callId ? groupOf.get(callId) : undefined;
          if (callId && host) {
            const after = (reviewsPlaced.get(callId) ?? 0) + 1;
            host.itemIds.splice(host.itemIds.indexOf(callId) + after, 0, id);
            reviewsPlaced.set(callId, after);
            groupOf.set(id, host);
            placed(host.at);
          } else if (callId) group("work", id);
          else push({ kind: "item", key: id, itemId: id }, false);
          break;
        }
        default:
          push({ kind: "item", key: id, itemId: id }, false);
      }
    for (const interactionId of asked ?? [])
      push(
        {
          kind: "question",
          key: `question:${interactionId}`,
          interactionId,
          itemId: interactionId === asked?.[0] ? replaced : undefined,
        },
        true,
      );
  }
  // Each ended turn's changed files after its last answer and, if it didn't complete, how it
  // ended after its last block: one pass that places them after those blocks.
  const after = new Map<number, Block[]>();
  const place = (index: number, block: Block) => {
    const list = after.get(index);
    if (list) list.push(block);
    else after.set(index, [block]);
  };
  for (const [id, turn] of turns) {
    const ending = id.startsWith("ask:") || id === "" ? "completed" : source.turnEnded?.(id);
    if (!ending || turn.lastBlock < 0) continue;
    if (turn.edits.length)
      place(turn.lastMessage >= 0 ? turn.lastMessage : turn.lastBlock, {
        kind: "files",
        key: `files:${id || turn.askId || "start"}`,
        itemIds: turn.edits,
      });
    if (ending !== "completed")
      place(turn.lastBlock, { kind: "end", key: `end:${id}`, runId: id, askId: turn.askId });
  }
  const result = after.size
    ? blocks.flatMap((block, index) => [block, ...(after.get(index) ?? [])])
    : blocks;
  // A turn that stopped or failed before any of its output arrived: the ask has no reply.
  const last = result.at(-1);
  if (source.stoppedTail && last?.kind === "user")
    result.push({ kind: "end", key: `end:${last.itemId}`, runId: undefined, askId: last.itemId });
  return result;
}

/** The items a block shows, for finding its turn and the row a jump lands on. */
export function blockItems(block: Block): readonly string[] {
  if ("itemIds" in block) return block.itemIds;
  if (block.kind === "question") return block.itemId === undefined ? [] : [block.itemId];
  if (block.kind === "end") return [];
  return [block.itemId];
}

/** Two blocks show the same thing: same kind, key and fields. */
export function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const fields = Object.keys(left);
  if (fields.length !== Object.keys(right).length) return false;
  return fields.every((field) => {
    const x = left[field];
    const y = right[field];
    if (Array.isArray(x) && Array.isArray(y))
      return x.length === y.length && x.every((value, index) => value === y[index]);
    return Object.is(x, y);
  });
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    return !!other && sameBlock(block, other);
  });
}
