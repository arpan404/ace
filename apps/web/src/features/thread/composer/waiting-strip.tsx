import { pluralCount, waitingOnSubagentsLabel, type TurnWait } from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { BackgroundTask } from "@ace/protocol";
import { useCallback, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ElapsedTime } from "@/components/working-indicator.tsx";
import { useStopCommands } from "./stop-strips.tsx";

const noTasks: readonly BackgroundTask[] = [];
const sameTasks = (a: readonly BackgroundTask[], b: readonly BackgroundTask[]) =>
  a.length === b.length && a.every((task, i) => task === b[i]);

/**
 * What the main agent waits on while it does nothing itself, its Stop at the far right: "Waiting
 * for 3 subagents · 5m 58s", or, its turn over, "Waiting for bun run dev:relay". Stop ends what it
 * waits on: the whole agent tree, or the background commands. "Stopping…" until the tree ends.
 */
export function WaitingStrip(props: {
  threadId: string;
  wait: TurnWait;
  /** When the turn's time started, for the timer beside subagents. */
  since: number | undefined;
  /** The agent tree can be stopped from here. */
  onStop?: (() => void) | undefined;
  stopping: boolean;
  indicators: ReactNode;
}) {
  const { wait } = props;
  return (
    <div
      role="status"
      aria-label={waitWords(wait)}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate">
        {wait.kind === "background" && wait.title ? (
          <span className="text-foreground">
            {"Waiting for "}
            <code className="font-mono">{wait.title}</code>
          </span>
        ) : (
          <span className="text-foreground">{waitWords(wait)}</span>
        )}
        {wait.kind === "subagents" && props.since !== undefined && (
          <span className="text-muted-foreground tabular-nums">
            {" · "}
            <ElapsedTime from={props.since} />
          </span>
        )}
      </span>
      {props.indicators}
      {wait.kind === "subagents" ? (
        <TreeStop onStop={props.onStop} stopping={props.stopping} />
      ) : (
        <CommandsStop threadId={props.threadId} taskIds={wait.taskIds} />
      )}
    </div>
  );
}

/** Stop for the agent tree, "Stopping…" while it is on its way. */
function TreeStop(props: { onStop?: (() => void) | undefined; stopping: boolean }) {
  if (props.stopping)
    return (
      <Button size="xs" variant="ghost" disabled>
        Stopping…
      </Button>
    );
  if (!props.onStop) return null;
  return (
    <Button size="xs" variant="ghost" aria-label="Stop the agent" onClick={props.onStop}>
      Stop
    </Button>
  );
}

/**
 * Stop for the background commands a finished turn waits on, in one press: every one of them the
 * provider can stop, whatever its kind. None of them can be stopped: no button, rather than a
 * dead one.
 */
function CommandsStop(props: { threadId: string; taskIds: readonly string[] }) {
  const { taskIds } = props;
  const keys = useMemo<readonly ThreadKey[]>(
    () => taskIds.map((id): ThreadKey => `task:${id}`),
    [taskIds],
  );
  const read = useCallback(
    (reader: ThreadReader) =>
      taskIds.flatMap((id) => {
        const task = reader.task(id);
        return task && task.status === "running" ? [task] : [];
      }),
    [taskIds],
  );
  const commands = useThread(props.threadId, keys, read, sameTasks) ?? noTasks;
  const { stoppable, sending, stopAll } = useStopCommands(commands);
  if (!stoppable.length) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={sending}
      aria-label={
        stoppable.length === 1 ? "Stop the background command" : "Stop the background commands"
      }
      onClick={stopAll}
    >
      Stop
    </Button>
  );
}

/** "Waiting for 2 subagents", "Waiting for bun run dev:relay", "Waiting for 2 background commands". */
function waitWords(wait: TurnWait): string {
  if (wait.kind === "subagents") return waitingOnSubagentsLabel(wait.count);
  return wait.title
    ? `Waiting for ${wait.title}`
    : `Waiting for ${pluralCount(wait.count, "background command", "background commands")}`;
}
