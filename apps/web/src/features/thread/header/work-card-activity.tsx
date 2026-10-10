import { useItem } from "@ace/client-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import type { Agent, BackgroundTask } from "@ace/protocol";
import { agentName, backgroundCommand, describeActivity, formatElapsed } from "@ace/ui-core";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import { useThreadLiveState } from "../lib/live-state.ts";
import { RowButton, TruncatedText } from "./work-card-parts.tsx";
import { agentNeedsYou, agentRunning, useWorkCardLive } from "./work-card-live.ts";

const labelClass = "flex items-center gap-2 px-2 pt-1 text-2xs leading-3 text-subtle-foreground";

/** Only agents and commands from this thread's projection; completed commands never appear. */
export function WorkCardActivity(props: { threadId: string; onClose(): void }) {
  const { agents, tasks } = useWorkCardLive(props.threadId);
  const [expanded, setExpanded] = useState(false);
  const finished = agents.filter(
    (agent) => agent.status.state === "idle" || agent.status.state === "interrupted",
  );
  const active = agents.filter(
    (agent) => agent.status.state !== "idle" && agent.status.state !== "interrupted",
  );
  const shown = expanded ? finished : finished.slice(-3);
  const running = agents.filter(agentRunning).length;
  return (
    <>
      {agents.length > 0 && (
        <section aria-label="Agents">
          <h3 className={labelClass}>Agents {running > 0 && <span>{running} running</span>}</h3>
          {[...active, ...shown].map((agent) => (
            <AgentLine key={agent.id} {...props} agent={agent} />
          ))}
          {finished.length > 3 && (
            <RowButton
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="text-muted-foreground"
            >
              {expanded ? "Show fewer" : `${finished.length - shown.length} done`}
            </RowButton>
          )}
        </section>
      )}
      {tasks.length > 0 && (
        <section aria-label="Background">
          <h3 className={labelClass}>Background</h3>
          {tasks.map((task) => (
            <CommandLine key={task.id} {...props} task={task} />
          ))}
        </section>
      )}
    </>
  );
}

function AgentLine(props: { threadId: string; agent: Agent; onClose(): void }) {
  const { agent } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const navigate = useNavigate();
  const live = useThreadLiveState(props.threadId);
  const running = agentRunning(agent);
  const now = useTicker(running && live.fresh);
  const name = agentName(agent);
  const needsYou = agentNeedsYou(agent);
  const activity = describeActivity(agent.status);
  const state = agent.status.state;
  const status =
    !live.fresh && running
      ? "Last seen"
      : needsYou
        ? state === "failed"
          ? "Failed"
          : "Needs you"
        : running
          ? formatElapsed(Math.max(0, now - agent.createdAt))
          : state === "interrupted"
            ? "Stopped"
            : "done";
  return (
    <Tip label={`${name} · ${activity}`}>
      <RowButton
        aria-label={`Open ${name}: ${status}`}
        onClick={() => {
          if (agent.childThreadId)
            void navigate({ to: "/t/$threadId", params: { threadId: agent.childThreadId } });
          else workspace.open({ kind: "agent", id: agent.id, title: name });
          props.onClose();
        }}
      >
        {state === "failed" ? (
          <XIcon aria-hidden size={12} className="shrink-0 text-status-failed" />
        ) : needsYou ? (
          <Dot tone="needs-you" />
        ) : running ? (
          <Spinner className="text-status-working" />
        ) : (
          <CheckIcon aria-hidden size={12} className="shrink-0 text-status-done" />
        )}
        <TruncatedText className={running || needsYou ? undefined : "text-muted-foreground"}>
          {name}
        </TruncatedText>
        <StatusLabel
          tone={needsYou ? (state === "failed" ? "failed" : "needs-you") : "idle"}
          label={status}
          mark={<></>}
          className="text-2xs font-normal"
        />
      </RowButton>
    </Tip>
  );
}

function CommandLine(props: { threadId: string; task: BackgroundTask; onClose(): void }) {
  const workspace = useWorkspaceActions(props.threadId);
  const item = useItem(props.threadId, props.task.toolCallId ?? "");
  const command = backgroundCommand(props.task, item);
  const live = useThreadLiveState(props.threadId);
  const now = useTicker(live.fresh);
  const status = !live.fresh
    ? "Last seen"
    : props.task.ambient || props.task.kind === "monitor"
      ? "watching"
      : `running ${formatElapsed(Math.max(0, now - props.task.startedAt))}`;
  return (
    <Tip label={command}>
      <RowButton
        aria-label={`Show ${command}: ${status}`}
        onClick={() => {
          workspace.open({ kind: "shell", id: props.task.id });
          props.onClose();
        }}
      >
        <Spinner className="text-status-working" />
        <TruncatedText className="font-mono">{command}</TruncatedText>
        <span className="shrink-0 text-2xs text-subtle-foreground">{status}</span>
      </RowButton>
    </Tip>
  );
}
