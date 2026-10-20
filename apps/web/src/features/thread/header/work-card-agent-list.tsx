import type { ThreadReader } from "@ace/client";
import { arrayEqual, useAgent, useThread } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { agentName, agentWorkState } from "@ace/ui-core";
import { useCallback, useState, type ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useTreeWork } from "@/features/panels/index.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { RowButton, RowCaret, RowLabel, RowStatic, RowSub, Section } from "./work-card-parts.tsx";

type Work = ReturnType<typeof useTreeWork>["work"];
type Close = () => void;

const none: readonly string[] = [];
const page = 5;

/**
 * The Agents section: `children` (a parent row) above the parent agent's subagents, running
 * first, settled behind their own toggle. Nothing to show, no section.
 */
export function AgentListSection(props: {
  threadId: string;
  parentAgentId: string;
  self: string | undefined;
  onClose: Close;
  children?: ReactNode;
}) {
  const read = useCallback(
    (reader: ThreadReader) => (props.parentAgentId ? reader.children(props.parentAgentId) : none),
    [props.parentAgentId],
  );
  const ids = useThread(props.threadId, ["agents"], read, arrayEqual) ?? none;
  const { work, agents } = useTreeWork(props.threadId);
  const live = useLiveConnection();
  const byId = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  const running: Agent[] = [];
  const settled: Agent[] = [];
  for (const id of ids) {
    const agent = byId.get(id);
    if (!agent) continue;
    const state = agentWorkState(agent, work, { fresh: live.fresh });
    if (state.running || state.needsYou) running.push(agent);
    else settled.push(agent);
  }
  const failed = settled.filter((agent) => agent.status.state === "failed").length;
  const [opened, setOpen] = useState<boolean>();
  // A settled agent on screen keeps its row in view: Completed starts open around it.
  const open = opened ?? settled.some((agent) => agent.id === props.self);
  const [allRunning, setAllRunning] = useState(false);
  const [allSettled, setAllSettled] = useState(false);
  if (running.length + settled.length === 0 && !props.children) return null;
  const title = running.length > 0 ? `Agents · ${running.length} running` : "Agents";
  const shownRunning = allRunning ? running : running.slice(0, page);
  const shownSettled = allSettled ? settled : settled.slice(0, page);
  return (
    <Section label="Agents" title={title}>
      {props.children}
      {shownRunning.map((agent) => (
        <SiblingRow
          key={agent.id}
          threadId={props.threadId}
          agentId={agent.id}
          self={agent.id === props.self}
          work={work}
          onClose={props.onClose}
        />
      ))}
      {running.length > page && !allRunning && (
        <RowButton onClick={() => setAllRunning(true)}>
          <RowLabel>Show {running.length - page} more</RowLabel>
        </RowButton>
      )}
      {settled.length > 0 && (
        <RowButton aria-expanded={open} onClick={() => setOpen(!open)}>
          <RowLabel>
            Completed ({settled.length})
            {!open && failed > 0 && <span className="text-status-failed"> · {failed} failed</span>}
          </RowLabel>
          <RowCaret className={open ? "rotate-180" : undefined} />
        </RowButton>
      )}
      {open &&
        shownSettled.map((agent) => (
          <SiblingRow
            key={agent.id}
            threadId={props.threadId}
            agentId={agent.id}
            self={agent.id === props.self}
            work={work}
            onClose={props.onClose}
          />
        ))}
      {open && settled.length > page && !allSettled && (
        <RowButton onClick={() => setAllSettled(true)}>
          <RowLabel>Show {settled.length - page} more</RowLabel>
        </RowButton>
      )}
    </Section>
  );
}

function SiblingRow(props: {
  threadId: string;
  agentId: string;
  self: boolean;
  work: Work;
  onClose: Close;
}) {
  const agent = useAgent(props.threadId, props.agentId);
  const live = useLiveConnection();
  const open = useOpenSubagent();
  if (!agent) return null;
  const name = agentName(agent);
  const status = agentWords(agent, props.work, live.fresh);
  const words = (
    <>
      <ProviderIcon
        provider={agent.native.provider}
        acpAgentId={agent.native.acpAgentId}
        model={agent.model}
        size={16}
        decorative
        className="shrink-0"
      />
      <RowLabel>{name}</RowLabel>
      <RowSub className="shrink-0">{status}</RowSub>
    </>
  );
  // The one on screen is where the reader is, not somewhere to go.
  if (props.self)
    return (
      <RowStatic label={`${name}, ${status}, shown`} className="bg-accent font-medium">
        {words}
      </RowStatic>
    );
  return (
    <RowButton
      aria-label={`Open ${name}, ${status}`}
      onClick={() => {
        props.onClose();
        open({ threadId: props.threadId, agentId: agent.id, childThreadId: agent.childThreadId });
      }}
    >
      {words}
    </RowButton>
  );
}

/** An agent's status with everything under it: never "Done" while its branch still runs. */
export function agentWords(agent: Agent, work: Work, fresh: boolean): string {
  const state = agentWorkState(agent, work, { fresh });
  return !state.running && agent.status.state === "idle" ? "Done" : state.label;
}
