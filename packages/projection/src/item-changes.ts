import type { EventPayload, Item } from "@ace/protocol";
import { applyDelta } from "./delta.ts";
import { structuredCopy } from "./structured-copy.ts";

/** An event that changes one transcript item (`changedItemId`). */
export type ItemChange = Extract<
  EventPayload,
  { type: "item.created" | "item.updated" | "item.delta" | "item.deleted" | "input.admitted" }
>;

/**
 * The transcript item `payload` changes, if any: the one definition the daemon (whether a
 * snapshot can stand in for a replay) and clients (what a read must catch up on) share. A
 * repeated `item.created` upserts an item that may already exist, so it is a change like an
 * update; `input.admitted` sets the native id of the `input:<command>` item it names. No other
 * event changes an item.
 */
export function changedItemId(payload: EventPayload): string | undefined {
  switch (payload.type) {
    case "item.created":
    case "item.updated":
      return payload.item.id;
    case "item.delta":
    case "item.deleted":
      return payload.itemId;
    case "input.admitted":
      return payload.commandId ? `input:${payload.commandId}` : undefined;
    default:
      return undefined;
  }
}

/** Whether `payload` changes a transcript item. */
export function isItemChange(payload: EventPayload): payload is ItemChange {
  return changedItemId(payload) !== undefined;
}

/**
 * Apply one item change to bodies read earlier, as the thread projection folds it, to the
 * items `bodies` holds: an item it does not hold is left alone (a create is not a page's to add).
 */
export function applyItemChange(bodies: Map<string, Item>, change: ItemChange): void {
  switch (change.type) {
    case "item.created":
    case "item.updated": {
      const previous = bodies.get(change.item.id);
      if (!previous) return;
      const item = structuredCopy(change.item);
      // Creation time is identity: a repeated create replaces content, never the timestamp.
      item.createdAt = previous.createdAt;
      bodies.set(change.item.id, item);
      return;
    }
    case "item.deleted":
      bodies.delete(change.itemId);
      return;
    case "item.delta": {
      const item = bodies.get(change.itemId);
      if (item) applyDelta(item, change.field, change.append);
      return;
    }
    case "input.admitted": {
      const item = change.commandId ? bodies.get(`input:${change.commandId}`) : undefined;
      if (item?.type === "message" && item.agentId === change.agentId)
        item.nativeId = change.nativeInputId;
      return;
    }
  }
}
