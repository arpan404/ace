import type { ThreadReader } from "@ace/client";
import { arrayEqual, useAgent, useThread } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { agentName } from "@ace/ui-core";
import { Fragment, useCallback, useState, type ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useTreeWork } from "@/features/panels/index.ts";
import { useThreadLiveState } from "../lib/live-state.ts";
import { agentListLine, agentWords } from "./live-words.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { RowButton, RowCaret, RowLabel, RowStatic, RowSub, Section } from "./work-card-parts.tsx";

type Work = ReturnType<typeof useTreeWork>["work"];
type Close = () => void;

const none: readonly string[] = [];
const page = 5;

/**
 * The Agents section: `children` (a parent row) above the parent agent's subagents, running
 * first, settled behind their own toggle. The toggle counts what happened to the whole group,
 * what still runs or waits first ("2 working · 25 finished · 1 failed"): an agent with work
 * pending under it is never counted finished. Nothing to show, no section. While the thread's
 * copy isn't confirmed the toggle and every row say so ("Reconnecting…") instead of a state.
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
  const live = useThreadLiveState(props.threadId);
  const byId = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  const listed = ids.flatMap((id) => byId.get(id) ?? []);
  const { running, settled, toggle } = agentListLine(live.live, listed, work);
  const [opened, setOpen] = useState<boolean>();
  // A settled agent on screen keeps its row in view: its toggle starts open around it.
  const open = opened ?? settled.some((agent) => agent.id === props.self);
  const [allRunning, setAllRunning] = useState(false);
  const [allSettled, setAllSettled] = useState(false);
  if (running.length + settled.length === 0 && !props.children) return null;
  const shownRunning = allRunning ? running : running.slice(0, page);
  const shownSettled = allSettled ? settled : settled.slice(0, page);
  return (
    <Section label="Agents" title="Agents">
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
            {typeof toggle === "string"
              ? toggle
              : toggle.map((part, index) => (
                  <Fragment key={part.text}>
                    {index > 0 && " · "}
                    <span className={part.quiet ? "text-subtle-foreground" : undefined}>
                      {part.text}
                    </span>
                  </Fragment>
                ))}
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
  const live = useThreadLiveState(props.threadId);
  const open = useOpenSubagent();
  if (!agent) return null;
  const name = agentName(agent);
  const status = agentWords(live.live, agent, props.work);
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
