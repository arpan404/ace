import { useItem } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { CaretDownIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { Agent, BackgroundTask } from "@ace/protocol";
import {
  agentName,
  agentStatusLabel,
  backgroundCommand,
  describeActivity,
  formatElapsed,
} from "@ace/ui-core";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import { useThreadLiveState } from "../lib/live-state.ts";
import { RowButton, TruncatedText } from "./work-card-parts.tsx";
import { agentNeedsYou, agentRunning, useWorkCardLive } from "./work-card-live.ts";
import { useWorkCardState } from "./work-card-state.tsx";

const labelClass = "flex items-center gap-2 px-2 text-xs text-subtle-foreground";

/** Lineage remains live until each agent's whole subtree and owned work settles. */
export function WorkCardActivity(props: { threadId: string; onClose(): void }) {
  const { agents, tasks, work } = useWorkCardLive(props.threadId);
  const { state, update } = useWorkCardState();
  const workspace = useWorkspaceActions(props.threadId);
  const live = useThreadLiveState(props.threadId);
  const expanded = state.sections["completed-agents"] ?? false;
  const settled = (agent: Agent) =>
    !work.running.has(agent.id) &&
    (agent.status.state === "idle" || agent.status.state === "interrupted");
  const finished = agents.filter(settled);
  const active = agents.filter((agent) => !settled(agent));
  const running = agents.filter((agent) => work.running.has(agent.id)).length;
  return (
    <section aria-label="Agents" className="py-3">
      <div className="flex items-center justify-between pb-1">
        <h3 className={labelClass}>
          Lineage · {running} {live.fresh ? "running" : "last seen"}
        </h3>
        <Menu>
          <MenuTrigger
            render={<IconButton icon={DotsThreeIcon} label="Lineage options" size="sm" />}
          />
          <MenuContent align="end">
            <MenuItem
              onClick={() => {
                workspace.open({ kind: "agents" });
                props.onClose();
              }}
            >
              Open agents panel
            </MenuItem>
            <MenuItem
              disabled={finished.length === 0}
              onClick={() => update({ sections: { "completed-agents": !expanded } })}
            >
              {expanded ? "Collapse previous agents" : "Expand previous agents"}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {active.map((agent) => (
        <AgentLine
          key={agent.id}
          {...props}
          agent={agent}
          running={work.running.has(agent.id)}
          needsYou={work.needsYou.has(agent.id)}
        />
      ))}
      {agents.length === 0 && (
        <p className="px-2 py-2 text-sm text-muted-foreground">No child agents</p>
      )}
      {tasks.length > 0 && (
        <section aria-label="Background">
          <h4 className={`${labelClass} pt-2`}>Background</h4>
          {tasks.map((task) => (
            <CommandLine key={task.id} {...props} task={task} />
          ))}
        </section>
      )}
      {finished.length > 0 && (
        <>
          <RowButton
            onClick={() => update({ sections: { "completed-agents": !expanded } })}
            aria-expanded={expanded}
            aria-controls={`previous-agents-${props.threadId}`}
            className="text-muted-foreground"
          >
            <span>Previous agents ({finished.length})</span>
            <span aria-hidden className="h-px min-w-0 flex-1 bg-border" />
            <CaretDownIcon aria-hidden size={12} className={expanded ? "rotate-180" : ""} />
          </RowButton>
          {expanded && (
            <div id={`previous-agents-${props.threadId}`}>
              {finished.map((agent) => (
                <AgentLine
                  key={agent.id}
                  {...props}
                  agent={agent}
                  running={false}
                  needsYou={false}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AgentLine(props: {
  threadId: string;
  agent: Agent;
  running: boolean;
  needsYou: boolean;
  onClose(): void;
}) {
  const { agent } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const navigate = useNavigate();
  const live = useThreadLiveState(props.threadId);
  const running = props.running;
  const now = useTicker(running && live.fresh);
  const name = agentName(agent);
  const needsYou = props.needsYou || agentNeedsYou(agent);
  const activity = describeActivity(agent.status);
  const state = agent.status.state;
  const status =
    !live.fresh && running
      ? "Last seen"
      : needsYou
        ? state === "unresponsive"
          ? "Unresponsive"
          : state === "failed"
            ? "Failed"
            : "Needs you"
        : running && !agentRunning(agent)
          ? "Waiting on work"
          : state === "blocked"
            ? agentStatusLabel(agent.status).label
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
        <span className="relative inline-flex shrink-0">
          <ProviderIcon
            provider={agent.native.provider}
            model={agent.model}
            acpAgentId={agent.native.acpAgentId}
            size={18}
            variant="mono"
          />
          <span className="absolute -bottom-0.5 -right-0.5">
            <Dot
              tone={
                needsYou
                  ? "needs-you"
                  : running
                    ? "working"
                    : state === "failed" || state === "unresponsive"
                      ? "failed"
                      : "done"
              }
            />
          </span>
        </span>
        <TruncatedText className={running || needsYou ? undefined : "text-muted-foreground"}>
          {name}
        </TruncatedText>
        <StatusLabel
          tone={agentStatusLabel(agent.status).tone}
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
    : props.task.status === "unknown"
      ? "Possibly running"
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
