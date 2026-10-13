import { useIntentSender, useItem, useThreadMeta } from "@ace/client-react";
import type { BackgroundTask } from "@ace/protocol";
import { backgroundCommand, pluralCount, runningSubagents } from "@ace/ui-core";
import { CalendarDotsIcon, TerminalIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useAutomations } from "@/features/automations/index.ts";
import { useBackgroundShells } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import {
  RowAction,
  RowButton,
  RowCaret,
  RowLabel,
  RowStatic,
  RowSub,
  Section,
  rowIcon,
} from "./work-card-parts.tsx";

const running = (task: BackgroundTask) => task.status === "running" || task.status === "unknown";

/**
 * What runs beside the agent: its subagents on one line, each background command with Stop,
 * and the project's scheduled automations. Shown only while something is there.
 */
export function RunningGroup(props: {
  threadId: string;
  workspaceId: string;
  workspacePath: string | undefined;
  onClose(): void;
}) {
  const meta = useThreadMeta(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const navigate = useNavigate();
  const shells = useBackgroundShells(props.threadId).filter(running);
  const automations =
    useAutomations().data?.filter(
      ({ automation }) =>
        automation.trigger.kind === "schedule" &&
        (automation.workspace === props.workspaceId ||
          automation.workspace === props.workspacePath),
    ).length ?? 0;
  const subagents = meta ? (meta.live?.runningSubagentCount ?? runningSubagents(meta.status)) : 0;
  if (!subagents && !shells.length && !automations) return null;
  return (
    <Section label="Running">
      {subagents > 0 && (
        <RowButton
          aria-label={`${pluralCount(subagents, "subagent", "subagents")} working, open the agent tree`}
          onClick={() => {
            workspace.open({ kind: "work" });
            props.onClose();
          }}
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <Spinner />
          </span>
          <span className="shrink-0">{pluralCount(subagents, "subagent", "subagents")}</span>
          <RowSub className="flex-1">working</RowSub>
        </RowButton>
      )}
      {shells.map((task) => (
        <ShellRow key={task.id} threadId={props.threadId} task={task} onClose={props.onClose} />
      ))}
      {automations > 0 && (
        <RowButton
          onClick={() => {
            props.onClose();
            void navigate({ to: "/automations" });
          }}
        >
          <CalendarDotsIcon aria-hidden size={16} className={rowIcon} />
          <RowLabel>{pluralCount(automations, "automation", "automations")}</RowLabel>
          <RowCaret to="elsewhere" />
        </RowButton>
      )}
    </Section>
  );
}

/** One background command: its output opens on a click, and Stop ends it. */
function ShellRow(props: { threadId: string; task: BackgroundTask; onClose(): void }) {
  const { task } = props;
  const item = useItem(props.threadId, task.toolCallId ?? "");
  const workspace = useWorkspaceActions(props.threadId);
  const stop = useIntentSender();
  const stopping = stop.intent?.state === "pending";
  const failed = stop.error !== undefined || stop.intent?.state === "failed";
  const command = backgroundCommand(task, item);
  return (
    <RowStatic label={command} className="hover:bg-accent">
      <TerminalIcon aria-hidden size={16} className={rowIcon} />
      <button
        type="button"
        className="focus-ring min-w-0 flex-1 truncate rounded-sm text-left font-mono text-xs"
        aria-label={`Show ${command} output`}
        title={command}
        onClick={() => {
          workspace.open({ kind: "shell", id: task.id });
          props.onClose();
        }}
      >
        {command}
      </button>
      {task.stoppable && (
        <RowAction
          disabled={stopping}
          aria-label={`Stop ${command}`}
          className={failed ? "text-status-failed" : undefined}
          title={failed ? "Couldn't stop this command. Try again." : undefined}
          onClick={() =>
            // The sender keeps a failed enqueue's error, which turns Stop into Retry.
            void stop.send({ type: "background_task.stop", taskId: task.id }).catch(() => {})
          }
        >
          {stopping ? "Stopping…" : failed ? "Retry" : "Stop"}
        </RowAction>
      )}
    </RowStatic>
  );
}
