import type { ThreadReader } from "@ace/client";
import { useAgent, useSidebarThread, useThread, useThreadMeta } from "@ace/client-react";
import { agentName, threadRowStatus } from "@ace/ui-core";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTreeWork } from "@/features/panels/index.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useSubagentFocus } from "../subagent/focus.ts";
import { AgentListSection, agentWords } from "./work-card-agent-list.tsx";
import { RowButton, RowLabel, RowSub, rowIcon } from "./work-card-parts.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";

type Close = () => void;

/**
 * The thread's agents: where this delegated thread or subagent came from, with the parent's status in
 * the words its sidebar row (or its agent row) uses, then the subagents started beside it. A
 * main agent lists the subagents it started. Only a thread with agents to show has one.
 */
export function AgentsSection(props: { threadId: string; onClose: Close }) {
  const agentId = useSubagentFocus();
  return agentId ? (
    <AgentFamily threadId={props.threadId} agentId={agentId} onClose={props.onClose} />
  ) : (
    <ThreadFamily threadId={props.threadId} onClose={props.onClose} />
  );
}

/**
 * A thread delegated by another's agent: its parent and siblings. Else its own subagents. A
 * fork is no one's agent: it lists its own subagents like any thread.
 */
function ThreadFamily(props: { threadId: string; onClose: Close }) {
  const parentId = useThreadMeta(props.threadId)?.delegatedBy;
  if (!parentId) return <MainAgents threadId={props.threadId} onClose={props.onClose} />;
  return (
    <DelegatedSiblings threadId={props.threadId} parentId={parentId} onClose={props.onClose} />
  );
}

function ParentThreadRow(props: { threadId: string; onClose: Close }) {
  const parent = useSidebarThread(props.threadId);
  const now = useNow();
  const navigate = useNavigate();
  const machine = useMachineSearch();
  const title = parent?.title ?? "Parent thread";
  const status = parent && threadRowStatus(parent, now);
  return (
    <RowButton
      aria-label={`Open parent ${title}${status ? `, ${status}` : ""}`}
      onClick={() => {
        props.onClose();
        void navigate({
          to: "/t/$threadId",
          params: { threadId: props.threadId },
          search: machine,
        });
      }}
    >
      <ArrowBendLeftUpIcon aria-hidden size={16} className={rowIcon} />
      <RowLabel>{title}</RowLabel>
      {status && <RowSub className="shrink-0">{status}</RowSub>}
    </RowButton>
  );
}

/** The other subagents the delegating agent started, read from the parent thread's tree. */
function DelegatedSiblings(props: { threadId: string; parentId: string; onClose: Close }) {
  const findSelf = useCallback(
    (reader: ThreadReader) =>
      reader.agentIds().find((id) => reader.agent(id)?.childThreadId === props.threadId),
    [props.threadId],
  );
  const self = useThread(props.parentId, ["agents"], findSelf);
  const delegator = useAgent(props.parentId, self ?? "")?.parentId ?? "";
  return (
    <AgentListSection
      threadId={props.parentId}
      parentAgentId={delegator}
      self={self}
      onClose={props.onClose}
    >
      <ParentThreadRow threadId={props.parentId} onClose={props.onClose} />
    </AgentListSection>
  );
}

/** The main agent's direct subagents: its own children in this thread's tree. */
function MainAgents(props: { threadId: string; onClose: Close }) {
  const readRoot = useCallback(
    (reader: ThreadReader) =>
      reader.thread?.rootAgentId ??
      reader.agentIds().find((id) => reader.agent(id)?.origin === "root") ??
      "",
    [],
  );
  const rootId = useThread(props.threadId, ["agents", "thread"], readRoot) ?? "";
  return (
    <AgentListSection
      threadId={props.threadId}
      parentAgentId={rootId}
      self={undefined}
      onClose={props.onClose}
    />
  );
}

/** A provider's own subagent: its parent and siblings are agents of the same thread. */
function AgentFamily(props: { threadId: string; agentId: string; onClose: Close }) {
  const agent = useAgent(props.threadId, props.agentId);
  const parent = useAgent(props.threadId, agent?.parentId ?? "");
  const { work } = useTreeWork(props.threadId);
  const live = useLiveConnection();
  const open = useOpenSubagent();
  if (!agent || !parent) return null;
  const status = agentWords(parent, work, live.fresh);
  const parentRow =
    parent.origin === "root" ? (
      <ParentThreadRow threadId={props.threadId} onClose={props.onClose} />
    ) : (
      <RowButton
        aria-label={`Open parent ${agentName(parent)}, ${status}`}
        onClick={() => {
          props.onClose();
          open({ threadId: props.threadId, agentId: parent.id });
        }}
      >
        <ArrowBendLeftUpIcon aria-hidden size={16} className={rowIcon} />
        <RowLabel>{agentName(parent)}</RowLabel>
        <RowSub className="shrink-0">{status}</RowSub>
      </RowButton>
    );
  return (
    <AgentListSection
      threadId={props.threadId}
      parentAgentId={parent.id}
      self={agent.id}
      onClose={props.onClose}
    >
      {parentRow}
    </AgentListSection>
  );
}
