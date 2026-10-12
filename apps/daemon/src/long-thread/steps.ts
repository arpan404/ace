import { toolSurfaces } from "@ace/projection";
import {
  TurnStepsResponse,
  type IconRef,
  type Item,
  type ThreadId,
  type ToolIcon,
  type TurnStep,
  type TurnStepsRequest,
} from "@ace/protocol";
import type { LongThreadDatabase } from "./database.ts";

/*
 * `turn.steps`: one turn's work, read on demand when its "Worked for" log opens, so a finished
 * turn never keeps every step in a client's memory. One indexed range read per page; each step
 * leaves its native payloads behind and its text at a bounded preview.
 */

export interface TurnStepsSource {
  data: LongThreadDatabase;
  /** The item at its step weight (text previews, tool bodies whole). */
  item(threadId: ThreadId, itemId: string): Item | undefined;
  /** The icon already resolved for a site or app, if any; never resolves here. */
  cachedIcon?: ((icon: ToolIcon) => IconRef | undefined) | undefined;
}

/** A page stops before this many encoded bytes, always holding at least one step. */
const pageBytes = 1024 * 1024;

/** Steps keep their native payloads only where their arguments live nowhere else. */
function light(item: Item): Item {
  if (item.type !== "tool_call" || item.call.detail.kind === "custom" || !item.call.raw.length)
    return item;
  return { ...item, call: { ...item.call, raw: [] } };
}

export function readTurnSteps(
  source: TurnStepsSource,
  query: TurnStepsRequest,
  head: number,
): TurnStepsResponse {
  const turn = source.data
    .sql("SELECT end_seq FROM long_turns WHERE thread_id=? AND ordinal=?")
    .get(query.threadId, query.turnOrdinal);
  if (!turn) throw new Error("turn_target_unavailable");
  // The person's own messages open the turn; everything else is its work or its answer.
  const rows = source.data
    .sql(
      "SELECT item_id,created_seq FROM long_items WHERE thread_id=? AND ordinal=? AND created_seq>? AND (role IS NULL OR role<>'user') ORDER BY created_seq LIMIT ?",
    )
    .all(query.threadId, query.turnOrdinal, query.after ?? 0, query.limit + 1);
  const steps: TurnStep[] = [];
  let bytes = 512;
  for (const row of rows.slice(0, query.limit)) {
    const item = source.item(query.threadId, String(row.item_id));
    if (!item) continue;
    const step = { seq: Number(row.created_seq), item: light(item) };
    const size = Buffer.byteLength(JSON.stringify(step));
    if (steps.length && bytes + size > pageBytes) break;
    bytes += size;
    steps.push(step);
  }
  const surfaces = toolSurfaces(steps.map((step) => step.item));
  for (const step of steps) {
    const surface = surfaces.get(step.item.id);
    if (!surface) continue;
    const iconRef = surface.icon ? source.cachedIcon?.(surface.icon) : undefined;
    Object.assign(step, { surface: iconRef ? { ...surface, iconRef } : surface });
  }
  const last = steps.at(-1)?.seq;
  const more = steps.length < rows.length;
  return TurnStepsResponse.parse({
    type: "turn.steps",
    requestId: query.requestId,
    threadId: query.threadId,
    turnOrdinal: query.turnOrdinal,
    seq: head,
    endSeq: Number(turn.end_seq),
    steps,
    after: more && last !== undefined ? last : null,
  });
}
