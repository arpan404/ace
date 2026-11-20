import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { AskedLine } from "@ace/protocol";
import { useCallback } from "react";

/*
 * ace's lines by the message they are about (ADR 0198), so a sent bubble draws the chips of the
 * bots, clubs, agents and devices it named. Built once per transcript window (its order changes
 * when a line arrives), never once per bubble.
 */

const built = new WeakMap<readonly string[], ReadonlyMap<string, AskedLine>>();

function index(reader: ThreadReader): ReadonlyMap<string, AskedLine> {
  const order = reader.order;
  const known = built.get(order);
  if (known) return known;
  const lines = new Map<string, AskedLine>();
  for (const id of order) {
    const item = reader.item(id);
    if (item?.type === "notice" && item.asked && !item.asked.words)
      lines.set(item.asked.about, item.asked);
  }
  built.set(order, lines);
  return lines;
}

/** ace's line about the person's message sent as `commandId`, when it named anyone. */
export function useAskedLine(
  threadId: string,
  commandId: string | undefined,
): AskedLine | undefined {
  const select = useCallback(
    (reader: ThreadReader) => (commandId ? index(reader).get(commandId) : undefined),
    [commandId],
  );
  return useThread(threadId, ["order"], select);
}
