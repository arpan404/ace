import type { ChangeTap, ThreadSource } from "@ace/client";
import { agentSheet, agentSheetPages, type AgentSheetLimits } from "@ace/ui-core/mobile";

/** Where patches go: the pump in the app, a recorder in tests. Readers run at delivery. */
export interface PatchSink {
  put(key: string, read: () => Record<string, unknown> | undefined): void;
  clear(prefix: string): void;
}
export type Preview = (text: string, limit: number) => string;

const key = "thread:agents";

/** Only entity changes reshape the tree; transcript deltas (20 a second) never do. */
export function touchesTree(keys: ReadonlySet<string>): boolean {
  for (const changed of keys)
    if (
      changed === "agents" ||
      changed === "tasks" ||
      changed === "interactions" ||
      changed === "thread" ||
      changed === "sync" ||
      changed === "unconfirmed" ||
      changed.startsWith("agent:") ||
      changed.startsWith("task:") ||
      changed.startsWith("interaction:") ||
      changed.startsWith("usage:") ||
      changed.startsWith("context:")
    )
      return true;
  return false;
}

/** The open sheet: stop following, or read one more page of agents or of background tasks. */
export interface AgentsFollow {
  stop(): void;
  more(list: "agents" | "tasks"): void;
}

/**
 * The Agents sheet while it is open: one coalesced patch for the tree, a page at a time. The
 * pump holds the reader, so a burst of status changes costs one shaping per delivered frame.
 * "Show more" adds a page to that list; the pages last until the sheet closes.
 */
export function followAgents(
  store: Pick<ThreadSource, "observe"> & Parameters<typeof agentSheet>[0],
  threadId: string,
  epoch: number,
  sink: PatchSink,
  preview: Preview,
  first?: AgentSheetLimits,
): AgentsFollow {
  const pages = { agents: 0, tasks: 0 };
  const put = () =>
    sink.put(key, () => {
      // The shaped sheet is fresh on every read, so its display text is bounded in place.
      const sheet = agentSheet(store, agentSheetPages(pages, first));
      for (const row of sheet.rows) {
        row.name = preview(row.name, 128);
        row.model = preview(row.model, 128);
        row.activity = preview(row.activity, 256);
      }
      for (const task of sheet.tasks) task.title = preview(task.title, 512);
      return { type: "agents.sheet", threadId, epoch, sheet };
    });
  const change: ChangeTap = (keys) => {
    if (keys === "all" || touchesTree(keys)) put();
  };
  const stop = store.observe(change);
  put();
  return {
    stop: () => {
      stop();
      sink.clear(key);
    },
    more: (list) => {
      pages[list]++;
      put();
    },
  };
}
