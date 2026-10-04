import type { Interaction, Item } from "@ace/protocol";

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

export function buildBlocks(source: BlockSource): Block[] {
  const blocks: Block[] = [];
  const anchors = anchorQuestions(source);
  let edits: string[] = [];
  // The work and spawn groups of the stretch since the last message; a message ends it.
  let stretch: Partial<Record<"work" | "subagents", { itemIds: string[] }>> = {};
  const group = (kind: "work" | "subagents", id: string) => {
    const open = stretch[kind];
    if (open) open.itemIds.push(id);
    else {
      const block = { kind, key: `${kind}:${id}`, itemIds: [id] };
      blocks.push(block);
      stretch[kind] = block;
    }
  };
  const standalone = (block: Block) => {
    blocks.push(block);
    stretch = {};
  };
  for (const id of source.order) {
    const item = source.item(id);
    if (!item) continue;
    const asked = anchors.get(id);
    // A question's own step: the question block stands in for it.
    const replaced =
      !!asked && item.type === "tool_call" && item.call.detail.kind === "ask_user" ? id : undefined;
    if (!replaced)
      switch (item.type) {
        case "message":
          if (item.synthetic) standalone({ kind: "event", key: id, itemId: id });
          else if (item.role === "user") standalone({ kind: "user", key: id, itemId: id });
          else {
            standalone({ kind: "message", key: id, itemId: id });
            if (edits.length) {
              blocks.push({ kind: "files", key: `files:${id}`, itemIds: edits });
              edits = [];
            }
          }
          break;
        case "tool_call": {
          const taskId = source.background.get(id);
          if (taskId !== undefined)
            blocks.push({ kind: "background", key: id, itemId: id, taskId });
          else if (item.call.kind === "agent.spawn") group("subagents", id);
          else {
            group("work", id);
            if (editKinds.has(item.call.kind)) edits.push(id);
          }
          break;
        }
        case "reasoning":
          group("work", id);
          break;
        case "notice":
          if (item.toolCallId) group("work", id);
          else standalone({ kind: "item", key: id, itemId: id });
          break;
        default:
          standalone({ kind: "item", key: id, itemId: id });
      }
    for (const interactionId of asked ?? [])
      standalone({
        kind: "question",
        key: `question:${interactionId}`,
        interactionId,
        itemId: interactionId === asked?.[0] ? replaced : undefined,
      });
  }
  return blocks;
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
