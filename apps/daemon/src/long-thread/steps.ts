import { toolSurface, toolSurfaces } from "@ace/projection";
import {
  ToolSurface,
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
 * leaves its native payloads behind and its text at a bounded preview. The person's own messages
 * (the ask, and any steer mid-turn) are left out: they stay in view in the transcript, outside
 * the fold.
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

/**
 * A surface as the wire carries it: one it can't (an odd host, a huge app id, a bad ref) loses
 * the part it can't, never the turn's read.
 */
function valid(surface: ToolSurface, iconRef?: IconRef): ToolSurface | undefined {
  const whole = ToolSurface.safeParse(iconRef ? { ...surface, iconRef } : surface);
  if (whole.success) return whole.data;
  const unresolved = ToolSurface.safeParse(surface);
  if (unresolved.success) return unresolved.data;
  const bare = ToolSurface.safeParse({ kind: surface.kind });
  return bare.success ? bare.data : undefined;
}

/** The site an agent's browser was on before `seq` in the same turn, from its earlier steps. */
function siteBefore(
  source: TurnStepsSource,
  threadId: ThreadId,
  ordinal: number,
  agentId: string | null,
  seq: number,
): string | undefined {
  const rows = source.data
    .sql(
      "SELECT item_id FROM long_items WHERE thread_id=? AND ordinal=? AND agent_id IS ? AND created_seq<? ORDER BY created_seq DESC LIMIT 64",
    )
    .all(threadId, ordinal, agentId, seq);
  for (const row of rows) {
    const item = source.item(threadId, String(row.item_id));
    if (item?.type !== "tool_call") continue;
    const icon = toolSurface(item.call)?.icon;
    if (icon?.kind === "site") return icon.origin;
  }
  return undefined;
}

/**
 * One recorded step's surface, worked out from the step itself (and the agent's earlier steps for
 * a browser step that names no URL). Undefined for a step that is not in the thread or drove no
 * surface: the icon of anything a client names is never looked up.
 */
export function stepSurface(
  source: TurnStepsSource,
  threadId: ThreadId,
  itemId: string,
): ToolSurface | undefined {
  const item = source.item(threadId, itemId);
  if (item?.type !== "tool_call") return undefined;
  const surface = toolSurface(item.call);
  if (!surface) return undefined;
  if (surface.kind === "browser" && !surface.icon) {
    const row = source.data
      .sql("SELECT ordinal,created_seq,agent_id FROM long_items WHERE thread_id=? AND item_id=?")
      .get(threadId, itemId);
    const origin = row
      ? siteBefore(
          source,
          threadId,
          Number(row.ordinal),
          row.agent_id == null ? null : String(row.agent_id),
          Number(row.created_seq),
        )
      : undefined;
    if (origin) return valid({ ...surface, icon: { kind: "site", origin } });
  }
  return valid(surface);
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
  const items = steps.map((step) => step.item);
  let surfaces = toolSurfaces(items);
  // A later page starts mid-turn: an agent's first URL-less browser step takes the site its
  // earlier steps were on.
  const first = steps[0]?.seq;
  if (query.after !== undefined && first !== undefined) {
    const carried = new Map<string, string>();
    for (const step of steps) {
      const surface = surfaces.get(step.item.id);
      const agent = step.item.agentId ?? "";
      if (surface?.kind !== "browser" || surface.icon || carried.has(agent)) continue;
      const origin = siteBefore(source, query.threadId, query.turnOrdinal, agent || null, first);
      if (origin) carried.set(agent, origin);
    }
    if (carried.size) surfaces = toolSurfaces(items, carried);
  }
  for (const step of steps) {
    const surface = surfaces.get(step.item.id);
    if (!surface) continue;
    const iconRef = surface.icon ? source.cachedIcon?.(surface.icon) : undefined;
    const shown = valid(surface, iconRef);
    if (shown) Object.assign(step, { surface: shown });
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
