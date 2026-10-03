import type { Item } from "@ace/protocol";

/**
 * The transcript reads like a document: consecutive tool work collapses into one "Worked for"
 * line, spawns into one "Started N subagents" line, and a changed-files card follows the answer
 * that comes after edits. Blocks depend only on item order, item types and kinds, and which
 * calls started background tasks, all of which are fixed once an item exists, so a streaming
 * delta never regroups the transcript.
 */
export type Block =
  | { kind: "user"; key: string; itemId: string }
  | { kind: "message"; key: string; itemId: string }
  | { kind: "work"; key: string; itemIds: string[] }
  | { kind: "subagents"; key: string; itemIds: string[] }
  | { kind: "background"; key: string; itemId: string; taskId: string }
  | { kind: "files"; key: string; itemIds: string[] }
  | { kind: "item"; key: string; itemId: string };

export interface BlockSource {
  order: readonly string[];
  item(id: string): Item | undefined;
  /** Tool call id → background task id, for calls that outlived their turn. */
  background: ReadonlyMap<string, string>;
}

const editKinds = new Set(["file.edit", "file.write", "file.delete", "file.move"]);

export function buildBlocks(source: BlockSource): Block[] {
  const blocks: Block[] = [];
  let edits: string[] = [];
  const group = (kind: "work" | "subagents", id: string) => {
    const last = blocks.at(-1);
    if (last?.kind === kind) last.itemIds.push(id);
    else blocks.push({ kind, key: `${kind}:${id}`, itemIds: [id] });
  };
  for (const id of source.order) {
    const item = source.item(id);
    if (!item) continue;
    switch (item.type) {
      case "message":
        if (item.synthetic) blocks.push({ kind: "item", key: id, itemId: id });
        else if (item.role === "user") blocks.push({ kind: "user", key: id, itemId: id });
        else {
          blocks.push({ kind: "message", key: id, itemId: id });
          if (edits.length) {
            blocks.push({ kind: "files", key: `files:${id}`, itemIds: edits });
            edits = [];
          }
        }
        break;
      case "tool_call": {
        const taskId = source.background.get(id);
        if (taskId !== undefined) blocks.push({ kind: "background", key: id, itemId: id, taskId });
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
        else blocks.push({ kind: "item", key: id, itemId: id });
        break;
      default:
        blocks.push({ kind: "item", key: id, itemId: id });
    }
  }
  return blocks;
}

export function blockItems(block: Block): readonly string[] {
  return "itemIds" in block ? block.itemIds : [block.itemId];
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    if (!other || other.kind !== block.kind || other.key !== block.key) return false;
    const mine = blockItems(block);
    const theirs = blockItems(other);
    return mine.length === theirs.length && mine.every((id, at) => id === theirs[at]);
  });
}
