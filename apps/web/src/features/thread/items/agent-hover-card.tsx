import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import { providerNames, subagentLabels } from "@ace/ui-core";
import type { ReactElement, ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { AgentIcon } from "./agent-lead.tsx";
import { subagentTones, type AgentRowParts } from "./agent-row.tsx";

/** Which agent a card is for: one the provider spawned, or a thread ace delegated. */
export type AgentCardSubject =
  | { kind: "subagent"; threadId: string; agentId: string }
  | { kind: "delegated"; threadId: string; childThreadId: string };

/**
 * An agent row's hover card, the sidebar's in a transcript's shape: who the agent is and how it
 * stands, whole where the row cuts it. Its name with its status and time on the same line, then
 * the account, model and effort it runs on under its provider's mark, then the machine it runs
 * on. A subagent runs on its parent's account; a delegated thread on its own. It opens under the
 * row (above when there's no room) once the pointer settles, and closes when it leaves.
 */
export function AgentHoverCard(props: {
  subject: AgentCardSubject;
  /** The row's own parts: name, status, time, mark, meta and machine. */
  parts: AgentRowParts;
  /** The row's link or button, one element. */
  children: ReactElement;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={450} closeDelay={0} render={props.children} />
      <HoverCardContent
        side="bottom"
        sideOffset={4}
        align="start"
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        aria-label={`Details for ${props.parts.name}`}
        className="w-80 max-w-[calc(100vw-24px)] px-3 py-2.5"
      >
        <CardBody subject={props.subject} parts={props.parts} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Mounted only while the card is open, so a closed row reads nothing extra. */
function CardBody(props: { subject: AgentCardSubject; parts: AgentRowParts }) {
  const { parts } = props;
  const account = useAgentAccount(props.subject);
  const here = usePrimaryMachine();
  // The model and effort as the row's meta reads them, without the row's own word for its kind.
  const model = parts.meta?.replace(/^(Delegated|New thread)( · )?/, "");
  const runs = [account, model || undefined].filter(Boolean).join(" · ");
  const made = runs || (parts.mark.provider ? providerNames[parts.mark.provider] : undefined);
  return (
    <div className="flex flex-col gap-1 text-ui">
      <div className="flex min-w-0 items-baseline gap-3">
        <p
          className="min-w-0 flex-1 truncate leading-5 font-medium text-foreground"
          title={parts.name}
        >
          {parts.name}
        </p>
        <p
          data-tone={subagentTones[parts.state]}
          className="flex shrink-0 items-baseline gap-1.5 text-xs text-(--tone-text)"
        >
          {subagentLabels[parts.state]}
          {parts.elapsed && (
            <span className="text-subtle-foreground tabular-nums">{parts.elapsed}</span>
          )}
        </p>
      </div>
      <div className="flex flex-col text-muted-foreground">
        {made && (
          <Fact>
            <AgentIcon {...parts.mark} size={16} className="text-muted-foreground" />
            <span className="min-w-0 truncate">{made}</span>
          </Fact>
        )}
        <Fact>
          <MachineMark icon={parts.machine ? undefined : here.icon} primary={!parts.machine} />
          <span className="min-w-0 truncate">{parts.machine ?? here.name}</span>
        </Fact>
      </div>
    </div>
  );
}

/** One line of the card: its glyph, then its words. */
function Fact(props: { children: ReactNode }) {
  return <div className="flex min-h-6 min-w-0 items-center gap-1.5">{props.children}</div>;
}

/** The account's name: a delegated thread's own, else the parent thread's, which a subagent shares. */
function useAgentAccount(subject: AgentCardSubject): string | undefined {
  const parent = useThreadMeta(subject.threadId);
  const child = useSidebarThread(subject.kind === "delegated" ? subject.childThreadId : "");
  const accounts = useAccountViews();
  const source = subject.kind === "delegated" ? child : parent;
  const id = source?.execution?.instanceId ?? source?.live?.account;
  return id ? accounts.data?.find((account) => account.id === id)?.label : undefined;
}
