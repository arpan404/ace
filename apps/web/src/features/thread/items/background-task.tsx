import { useIntentSender, useItem, useTask } from "@ace/client-react";
import { StopIcon, TerminalIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import { formatElapsed } from "@ace/ui-core";

const ended = {
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "May still be running",
  running: "Running in background",
};

/**
 * "Running in background `bun run dev:relay` 6m [Stop]". Stopping sends a durable intent; the
 * line changes when the daemon reports the task ended, not when the button is pressed.
 */
export function BackgroundTaskLine(props: { threadId: string; itemId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  const item = useItem(props.threadId, props.itemId);
  const running = task?.status === "running";
  const now = useTicker(running);
  const { send, intent, error } = useIntentSender();
  const workspace = useWorkspaceActions(props.threadId);
  if (!task) return null;
  const command =
    item?.type === "tool_call" && item.call.detail.kind === "shell"
      ? item.call.detail.command
      : task.title;
  const elapsed = (task.endedAt ?? now) - task.startedAt;
  // A clock disagreement with the daemon shows no age rather than a wrong one.
  const age = elapsed >= 0 && elapsed < 7 * 24 * 3_600_000 ? formatElapsed(elapsed) : undefined;
  const stopping = intent?.state === "pending" || (intent?.state === "acked" && running);
  return (
    <div role="group" aria-label={`Background task ${command}`} className="@container">
      {/* One line: the command gives way with an ellipsis. Phone-narrow, the label and Stop keep
          the first line and the command takes the second. */}
      <div className="-mx-1.5 flex min-h-7 items-center gap-x-2 gap-y-0.5 rounded-[7px] px-1.5 text-[13.5px] text-muted-foreground @max-[360px]:flex-wrap">
        <span className="flex shrink-0 items-center gap-2">
          <TerminalIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
          {ended[task.status]}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 @max-[360px]:order-last @max-[360px]:basis-full">
          {task.kind === "shell" ? (
            // The shell's output opens as a read-only tab in the bottom panel.
            <button
              type="button"
              title="Show its output"
              aria-label={`Show output of ${command}`}
              // The workspace's agent-shell tab (features/panels/terminal/tabs.ts); it names itself.
              onClick={() => workspace.open({ kind: "shell", id: task.id })}
              className="min-w-0 truncate rounded-[5px] bg-secondary px-1.5 py-px font-mono text-[12.5px] text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            >
              {command}
            </button>
          ) : (
            <code className="min-w-0 truncate rounded-[5px] bg-secondary px-1.5 py-px font-mono text-[12.5px] text-foreground">
              {command}
            </code>
          )}
          {age && (
            <span className="shrink-0 text-subtle-foreground">{age.replace(/ \d+s$/, "")}</span>
          )}
        </span>
        {intent?.state === "failed" || error ? (
          <span role="alert" className="ml-auto shrink-0 text-xs text-status-failed">
            Couldn't stop it
          </span>
        ) : null}
        {running && task.stoppable && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            disabled={stopping}
            onClick={() =>
              void send({ type: "background_task.stop", taskId: task.id }).catch(() => {})
            }
          >
            {stopping ? <Spinner /> : <StopIcon aria-hidden size={14} />}
            {stopping ? "Stopping" : "Stop"}
          </Button>
        )}
      </div>
    </div>
  );
}
