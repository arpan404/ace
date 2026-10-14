import { backgroundCommand, formatSpan, taskState } from "@ace/ui-core";
import { useItem, useTask } from "@ace/client-react";
import { ClockIcon, StopIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { capsule, CapsuleGlyph, CapsuleMeta } from "./task-capsule.tsx";
import { useStopIntent } from "./use-stop-intent.ts";

/** Hover and focus reveal a row's actions; touch, with no hover, always shows them. */
const onHover =
  "hidden group-focus-within/task:flex group-hover/task:flex pointer-coarse:flex items-center gap-0.5";

/**
 * Summary's background work: each command still running, with how long it has run, Open in
 * terminal and Stop; then the composer's queued input in one line.
 */
export function BackgroundList(props: {
  threadId: string;
  taskIds: readonly string[];
  queued: number;
  queueWaiting: boolean;
}) {
  return (
    <ArrivalScope>
      <ul>
        {props.taskIds.map((id) => (
          <TaskRow key={id} threadId={props.threadId} taskId={id} />
        ))}
        {(props.queued > 0 || props.queueWaiting) && <QueueRow count={props.queued} />}
      </ul>
    </ArrivalScope>
  );
}

/** One background command still running: its command, its time and state, then its actions. */
function TaskRow(props: { threadId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  const arrival = useArrival();
  const now = useNow();
  const stop = useStopIntent();
  const workspace = useWorkspaceActions(props.threadId);
  const item = useItem(props.threadId, task?.toolCallId ?? "");
  if (!task || (task.status !== "running" && task.status !== "unknown")) return null;
  const command = backgroundCommand(task, item);
  const end = Math.max(now, task.startedAt);
  const show = () => workspace.open({ kind: "shell", id: task.id });
  return (
    <li
      aria-label={`${task.title}: ${taskState(task)}`}
      className={cn(
        "group/task flex min-h-8 flex-wrap items-center gap-2 pr-1 pl-2",
        capsule,
        arrival,
      )}
    >
      <CapsuleGlyph state="background" />
      <button
        type="button"
        className="focus-ring min-w-0 shrink truncate rounded-sm font-mono text-xs"
        onClick={show}
        aria-label={`Show ${command} output`}
      >
        {command}
      </button>
      <CapsuleMeta className="flex-1 tabular-nums">
        {end - task.startedAt >= 1000 ? `${formatSpan(task.startedAt, end)} · ` : ""}
        {taskState(task)}
      </CapsuleMeta>
      <span className={onHover}>
        <IconButton icon={TerminalWindowIcon} label="Open in terminal" size="sm" onClick={show} />
        {task.stoppable && (
          <Button
            size="sm"
            variant="secondary"
            disabled={stop.busy}
            onClick={() => void stop.send({ type: "background_task.stop", taskId: task.id })}
          >
            <StopIcon aria-hidden size={14} weight="fill" />
            {stop.busy ? "Stopping…" : "Stop"}
          </Button>
        )}
      </span>
      {stop.failed && (
        <span role="alert" className="w-full pb-1 text-xs text-status-failed">
          Couldn't stop this command. Try again.
        </span>
      )}
    </li>
  );
}

/** "1 queued message · sends when the agent is free", the composer's queue in one line. */
function QueueRow(props: { count: number }) {
  const arrival = useArrival();
  const label =
    props.count > 1
      ? `${props.count} queued messages`
      : props.count === 1
        ? "1 queued message"
        : "Queued messages";
  return (
    <li
      aria-label={`${label}: waiting for the agent`}
      className={cn("flex h-8 items-center gap-2 px-2 text-ui", capsule, arrival)}
    >
      <span className="grid size-[18px] shrink-0 place-items-center text-muted-foreground">
        <ClockIcon aria-hidden size={15} />
      </span>
      <span className="min-w-0 truncate font-medium">{label}</span>
      <CapsuleMeta className="flex-1">
        {props.count > 1 ? "send" : "sends"} when the agent is free
      </CapsuleMeta>
    </li>
  );
}
