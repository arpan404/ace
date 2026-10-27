import type { ChangeTap, ThreadReader } from "@ace/client";
import { subagentInspection } from "@ace/ui-core/mobile";
import { touchesTree } from "./agents.ts";
import { preview } from "./presentation.ts";

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

/**
 * What the open lane's subagent is, as one coalesced patch (`subagentInspection`): its prompt,
 * where its branch stands, the requests under it, Stop and Ask parent to retry. Read again only
 * when the tree, its requests or the thread change; streamed text never reshapes it.
 */
export function followLaneInfo(
  store: ThreadReader,
  agentId: string,
  put: Put,
  now: () => number,
): ChangeTap {
  const send = () =>
    put("laneInfo", () => {
      const info = subagentInspection(store, agentId, now());
      if (info) {
        info.name = preview(info.name, 256);
        info.parent.name = preview(info.parent.name, 256);
        if (info.prompt) info.prompt.text = preview(info.prompt.text, 16_384);
      }
      return { type: "thread.laneInfo", lane: agentId, info: info ?? null };
    });
  send();
  return (keys) => {
    if (keys === "all" || touchesTree(keys)) send();
  };
}
