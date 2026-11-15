import type { Item } from "@ace/protocol";
import { systemInput } from "./system-events.ts";

const continuing = new Set(["restart", "limit_resume"]);

/**
 * The person's own message: what they typed or queued. What ace or the provider wrote for them
 * never starts a turn on screen, and neither does ace's continuation after a restart or a usage
 * limit ("Continue where you left off.", or an older build's instructions stored without an
 * origin): the turn it continues carries on, and the input waits behind that turn's restart or
 * limit row.
 */
export function isPersonMessage(item: Item | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user" || item.synthetic) return false;
  // A person's message carries its origin, so only older history is read for ace's fixed texts.
  if (item.origin?.kind === "person" || item.origin?.kind === "queue") return true;
  return !continuing.has(systemInput(item)?.kind ?? "");
}
