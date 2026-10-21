import { waitText, waitWords, type TurnWait, type WaitWords } from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useItem, useThread } from "@ace/client-react";
import { shellCommandOf } from "@ace/projection";
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
 * for 3 subagents · 5m 58s", or, its turn over, "Running `bun run dev:relay`". Stop ends what it
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
  if (wait.kind === "background")
    return <CommandsStrip threadId={props.threadId} wait={wait} indicators={props.indicators} />;
  const words = waitWords(wait);
  return (
    <div
      role="status"
      aria-label={waitText(words)}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate">
        <Words words={words} />
        {props.since !== undefined && (
          <span className="text-muted-foreground tabular-nums">
            {" · "}
            <ElapsedTime from={props.since} />
          </span>
        )}
      </span>
      {props.indicators}
      <TreeStop onStop={props.onStop} stopping={props.stopping} />
    </div>
  );
}

/**
 * The background commands a stopped turn left running, said as a finished turn's are: the run
 * already reads stopped in the transcript, so the strip only says what still runs.
 */
export function StoppedStrip(props: {
  threadId: string;
  commands: readonly BackgroundTask[];
  indicators: ReactNode;
}) {
  const { commands } = props;
  const single = commands.length === 1 ? commands[0] : undefined;
  const item = useItem(props.threadId, single?.toolCallId ?? "");
  const taskIds = useMemo(() => commands.map((task) => task.id), [commands]);
  const wait: TurnWait = {
    kind: "background",
    count: commands.length,
    title: single ? shellCommandOf(single, item) : undefined,
    shells: true,
    taskIds,
  };
  return <CommandsStrip threadId={props.threadId} wait={wait} indicators={props.indicators} />;
}

/** "Running 2 commands" or "Running `bun run dev`", with one Stop for all of them. */
function CommandsStrip(props: {
  threadId: string;
  wait: Extract<TurnWait, { kind: "background" }>;
  indicators: ReactNode;
}) {
  const words = waitWords(props.wait);
  return (
    <div
      role="status"
      aria-label={waitText(words)}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate">
        <Words words={words} />
      </span>
      {props.indicators}
      <CommandsStop threadId={props.threadId} taskIds={props.wait.taskIds} />
    </div>
  );
}

/** The strip's lead words, a single shell's command as code, then what runs beside it. */
function Words(props: { words: WaitWords }) {
  const { label, code, detail } = props.words;
  return (
    <>
      <span className="text-foreground">
        {label}
        {code !== undefined && (
          <>
            {" "}
            <code className="font-mono">{code}</code>
          </>
        )}
      </span>
      {detail && <span className="text-muted-foreground">{` · ${detail}`}</span>}
    </>
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
 * Stop for the background commands left running, in one press: every one of them the provider
 * can stop, whatever its kind. None of them can be stopped: no button, rather than a dead one.
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
