import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { ledgerOf } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { BackgroundTaskGroup, BackgroundTaskLine } from "./background-task-line.tsx";
import { RailMark, type RailState } from "./step-rail.tsx";

/*
 * Commands left running in the background, as steps of the work log where they started: one
 * task's line ("Running in background `bun run dev` 6m [Stop]"), or several started back to back
 * as one group ("2 background tasks · 1 running", its running lines in view). The rows update in
 * place as the tasks end; they never move.
 */

const taskKeys: readonly ThreadKey[] = ["tasks"];

function sameCalls(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, task] of a) if (b.get(id) !== task) return false;
  return true;
}

/**
 * Which of a log's calls left a command running in the background, by its task. Read again
 * only when tasks change, in time proportional to the log, not the thread.
 */
export function useBackgroundCalls(
  threadId: string,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const read = useCallback(
    (reader: ThreadReader) => {
      const background = ledgerOf(reader).background;
      const calls = new Map<string, string>();
      if (!background.size) return calls;
      for (const id of ids) {
        const task = background.get(id);
        if (task !== undefined) calls.set(id, task);
      }
      return calls;
    },
    [ids],
  );
  return useThread(threadId, taskKeys, read, sameCalls) ?? noCalls;
}

const noCalls: ReadonlyMap<string, string> = new Map();

/** The rail's mark for the tasks: running while any runs, failed if any failed. */
function railState(reader: ThreadReader, taskIds: readonly string[]): RailState {
  const statuses = taskIds.map((id) => reader.task(id)?.status);
  if (statuses.some((status) => status === "running")) return "running";
  return statuses.some((status) => status === "failed") ? "failed" : "done";
}

export function BackgroundStep(props: {
  threadId: string;
  itemIds: readonly string[];
  calls: ReadonlyMap<string, string>;
}) {
  const { itemIds, calls } = props;
  const taskIds = useMemo(() => itemIds.map((id) => calls.get(id) ?? ""), [itemIds, calls]);
  const keys = useMemo(() => taskIds.map((id): ThreadKey => `task:${id}`), [taskIds]);
  const readState = useCallback((reader: ThreadReader) => railState(reader, taskIds), [taskIds]);
  const state = useThread(props.threadId, keys, readState, Object.is) ?? "done";
  const [onlyItem] = itemIds;
  const [onlyTask] = taskIds;
  return (
    <li className="relative min-w-0">
      <RailMark state={state} />
      {itemIds.length === 1 && onlyItem !== undefined && onlyTask !== undefined ? (
        <BackgroundTaskLine threadId={props.threadId} itemId={onlyItem} taskId={onlyTask} />
      ) : (
        <BackgroundTaskGroup threadId={props.threadId} itemIds={itemIds} taskIds={taskIds} />
      )}
    </li>
  );
}
