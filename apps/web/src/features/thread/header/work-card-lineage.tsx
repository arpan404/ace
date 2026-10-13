import type { ThreadReader } from "@ace/client";
import {
  arrayEqual,
  useAgent,
  useSidebarThread,
  useThread,
  useThreadMeta,
} from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { agentName, agentWorkState, threadRowStatus } from "@ace/ui-core";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useTreeWork } from "@/features/panels/index.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useSubagentFocus } from "../subagent/focus.ts";
import { RowButton, RowLabel, RowStatic, RowSub, Section, rowIcon } from "./work-card-parts.tsx";

type Work = ReturnType<typeof useTreeWork>["work"];
type Close = () => void;

/**
 * Where this thread or subagent came from: its parent, with the parent's status in the words
 * its sidebar row (or its agent row) uses, then the subagents started beside it. Only a child
 * has one: a fork, a thread ace delegated, or a provider's own subagent.
 */
export function LineageSection(props: { threadId: string; onClose: Close }) {
  const agentId = useSubagentFocus();
  return agentId ? (
    <AgentFamily threadId={props.threadId} agentId={agentId} onClose={props.onClose} />
  ) : (
    <ThreadFamily threadId={props.threadId} onClose={props.onClose} />
  );
}

/** A thread forked from another, or delegated by one of its agents. */
function ThreadFamily(props: { threadId: string; onClose: Close }) {
  const meta = useThreadMeta(props.threadId);
  const forkedFrom = meta?.lineage?.parentThreadId;
  const parentId = forkedFrom ?? meta?.delegatedBy;
  if (!parentId) return null;
  return (
    <Section label="Lineage" title="Lineage">
      <ParentThreadRow threadId={parentId} onClose={props.onClose} />
      {!forkedFrom && (
        <DelegatedSiblings threadId={props.threadId} parentId={parentId} onClose={props.onClose} />
      )}
    </Section>
  );
}

function ParentThreadRow(props: { threadId: string; onClose: Close }) {
  const parent = useSidebarThread(props.threadId);
  const now = useNow();
  const navigate = useNavigate();
  const title = parent?.title ?? "Parent thread";
  const status = parent && threadRowStatus(parent, now);
  return (
    <RowButton
      aria-label={`Open parent ${title}${status ? `, ${status}` : ""}`}
      onClick={() => {
        props.onClose();
        void navigate({ to: "/t/$threadId", params: { threadId: props.threadId } });
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
    <Siblings
      threadId={props.parentId}
      parentAgentId={delegator}
      self={self}
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
  return (
    <Section label="Lineage" title="Lineage">
      {parent.origin === "root" ? (
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
      )}
      <Siblings
        threadId={props.threadId}
        parentAgentId={parent.id}
        self={agent.id}
        onClose={props.onClose}
      />
    </Section>
  );
}

function Siblings(props: {
  threadId: string;
  parentAgentId: string;
  self: string | undefined;
  onClose: Close;
}) {
  const read = useCallback(
    (reader: ThreadReader) => (props.parentAgentId ? reader.children(props.parentAgentId) : none),
    [props.parentAgentId],
  );
  const ids = useThread(props.threadId, ["agents"], read, arrayEqual) ?? none;
  const { work } = useTreeWork(props.threadId);
  return ids.map((id) => (
    <SiblingRow
      key={id}
      threadId={props.threadId}
      agentId={id}
      self={id === props.self}
      work={work}
      onClose={props.onClose}
    />
  ));
}
const none: readonly string[] = [];

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
function agentWords(agent: Agent, work: Work, fresh: boolean): string {
  const state = agentWorkState(agent, work, { fresh });
  return !state.running && agent.status.state === "idle" ? "Done" : state.label;
}
